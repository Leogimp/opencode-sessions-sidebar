/**
 * TUI plugin:
 * 1. Renders open sessions as a "Sessions" block at the bottom of the
 *    sidebar content area (sidebar.content). The sidebar.footer directory
 *    indicator stays below it. Rows: status icon + title, active session
 *    highlighted; click a row to switch to that session. A centered "+" row
 *    below the list creates a new session and switches to it.
 * 2. Owns the built-in top tab strip: while the plugin is installed, `tabs.mode`
 *    stays forced to "off" — setup sets it, a watcher re-asserts it whenever
 *    the file changes (the settings dialog toggles the same key, and the TUI
 *    re-reads cli.json live, so a dialog change snaps back within ~150 ms),
 *    and nothing restores a previous value while the plugin remains
 *    installed. After uninstalling, re-enable the strip in Settings. Session
 *    tracking and navigation are handled by this plugin itself, because the
 *    built-in tab store stops tracking when the strip is disabled.
 */
/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { RGBA } from "@opentui/core"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "fs"
import { basename, dirname, join } from "path"
import { homedir } from "os"
import { Plugin } from "@opencode/plugin/tui"

const MAX_TABS = 10
const ICON = { busy: "\u25CF", attention: "\u25B2", idle: "\u25CF" }
// Busy dots breathe smoothly (cosine curve, ~1.2s cycle) while the agent
// is responding; static at full brightness when animations are disabled.
const PULSE_STEPS = 24
const PULSE_INTERVAL_MS = 50
const PULSE_MIN = 0.15

type Tab = { sessionID: string; title?: string }

// --- Top strip ownership ----------------------------------------------------
// While the plugin is installed it owns `tabs.mode`: setup forces the strip
// off and keeps it off — the previous value is never restored while the
// plugin remains installed, across restarts. The re-assertion below is what
// wins against the settings dialog: the dialog writes the same key, and the
// running TUI re-reads cli.json on every file change, so a dialog change
// snaps back to "off" within ~150 ms. Only uninstalling gives the strip
// back, by re-enabling it in Settings.
//
// `tabs.mode` ("auto" | "on" | "off") is the current setting; the older
// `tabs.enabled` boolean is still accepted but is a legacy alias. The plugin
// only ever writes `mode`, and drops `enabled` while it forces the strip
// off, so the two keys can never disagree.

// True when the configured tabs keys already resolve to "strip off".
// `mode` wins when present; `enabled: false` is only consulted on its own.
function tabsAreOff(tabs: any): boolean {
  const mode = tabs?.mode
  if (typeof mode === "string") return mode === "off"
  return tabs?.enabled === false
}

// Resolves cli.json the way OpenCode does: $OPENCODE_CONFIG_DIR wins, then
// $XDG_CONFIG_HOME/opencode, then ~/.config/opencode. The file may not exist
// yet — setup creates it.
function locateCliJson(): string {
  const root =
    process.env.OPENCODE_CONFIG_DIR ??
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homedir(), ".config", "opencode"))
  return join(root, "cli.json")
}

// Atomic replacement (temp + rename) so concurrent readers — every OpenCode
// window watches cli.json — never see a half-written file.
function writeJsonAtomic(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, text)
    renameSync(temp, file)
  } catch {
    try {
      writeFileSync(file, text)
    } finally {
      try {
        unlinkSync(temp)
      } catch {}
    }
  }
}

type ModifyResult = "written" | "unchanged" | "missing" | "unparsable"

// Parses cli.json, applies mutate(json); writes the file back (atomically)
// when mutate returns true. Never throws.
function modifyCliJson(mutate: (json: any) => boolean): ModifyResult {
  const file = locateCliJson()
  if (!existsSync(file)) return "missing"
  try {
    const json = JSON.parse(readFileSync(file, "utf8"))
    if (!json || typeof json !== "object") return "unparsable"
    if (!mutate(json)) return "unchanged"
    writeJsonAtomic(file, JSON.stringify(json, null, 2) + "\n")
    return "written"
  } catch {
    // Unparsable (e.g. JSONC comments) or unexpected config; leave it alone.
    return "unparsable"
  }
}

// The busy-dot pulse honours the global `animations` setting. There is no
// context API for it — `Data` has no such field — so read it from the same
// cli.json the plugin already resolves, preferring inline config when the
// host supplied any. Unknown/absent/unreadable means "leave it on", which
// matches OpenCode's own default. Never throws.
function readAnimations(): boolean {
  let text = process.env.OPENCODE_CLI_CONFIG_CONTENT
  if (text === undefined) {
    try {
      const file = locateCliJson()
      if (existsSync(file)) text = readFileSync(file, "utf8")
    } catch {
      return true
    }
  }
  if (text === undefined) return true
  try {
    const json = JSON.parse(text)
    if (!json || typeof json !== "object") return true
    return json.animations !== false
  } catch {
    return true
  }
}

// Sidebar inner width is fixed (42 cols minus padding): icon + gaps + the
// close glyph leave ~33 columns for the title. Clip long titles with a
// trailing ellipsis instead of relying on the text element's truncator,
// which cuts head+tail in the middle.
const TITLE_MAX = 32

function clipTitle(value: string, max: number): string {
  const chars = Array.from(value)
  if (chars.length <= max) return value
  return chars.slice(0, Math.max(0, max - 1)).join("") + "\u2026"
}

// Dim a theme color (RGBA) for the pulse's low phases; non-RGBA colors are
// returned untouched so the dot just stays solid.
function dimColor(color: any, factor: number): any {
  if (factor >= 1) return color
  if (color && typeof color === "object" && "r" in color) {
    return RGBA.fromValues(color.r, color.g, color.b, (color.a ?? 1) * factor)
  }
  return color
}

// Pure helper: status icon + color for one session (mirrors the built-in
// tab strip logic: busy when the session or any family member is running
// or has pending work; attention on pending permissions/questions).
function statusOf(ctx: any, sessionID: string, theme: any, pulse: number, idleColor: any) {
  const family: string[] = ctx.data.session.family(sessionID) ?? [sessionID]
  const busy = family.some(
    (id: string) =>
      ctx.data.session.status(id) === "running" ||
      (ctx.data.session.pending.list(id) ?? []).some((p: any) => p.type !== "synthetic"),
  )
  const attention = family.some((id: string) => (ctx.data.session.permission.list(id)?.length ?? 0) > 0)
    ? "permission"
    : family.some((id: string) => (ctx.data.session.form.list(id)?.length ?? 0) > 0)
      ? "question"
      : false
  if (attention) return { char: ICON.attention, fg: theme.text.feedback.warning.base }
  if (busy) return { char: ICON.busy, fg: dimColor(theme.hue.accent[200], pulse) }
  return { char: ICON.idle, fg: idleColor }
}

function SessionsBlock(props: any) {
  const ctx = props.context
  const theme = () => ctx.theme
  // storage.store() returns [storeObject, updateFn] — read via property
  // access on the store object, write via the updater.
  const [tabStore, setStore] = ctx.storage.store("tabs", { initial: { sessions: [] } })
  const entries = () => (tabStore.sessions ?? []) as Tab[]
  const route = () => ctx.ui.router.current()
  const activeId = () => (route()?.type === "session" ? (ctx.data.session.root(route()!.sessionID) as string) : undefined)

  // Capture navigation once per route change. Tracking is append-only: a
  // session keeps its row position once opened, so rows never shuffle.
  // Newest session lands at the bottom.
  createEffect(() => {
    const r = route()
    if (!r || r.type !== "session") return
    untrack(() => {
      const root = ctx.data.session.root(r.sessionID) as string
      if (entries().some((t: Tab) => t.sessionID === root)) return
      const title = ctx.data.session.get(root)?.title as string | undefined
      setStore((draft: any) => {
        const rest = (draft.sessions ?? []).slice(-(MAX_TABS - 1))
        draft.sessions = [...rest, { sessionID: root, title }]
      })
    })
  })

  // Refresh the stored title of the active session in place (used as
  // fallback once session data is evicted). Order never changes here.
  createEffect(() => {
    const id = activeId()
    if (!id) return
    const title = ctx.data.session.get(id)?.title as string | undefined
    untrack(() => {
      const entry = entries().find((t: Tab) => t.sessionID === id)
      if (!entry || (entry.title ?? undefined) === (title ?? undefined)) return
      setStore((draft: any) => {
        const d = (draft.sessions ?? []).find((t: Tab) => t.sessionID === id)
        if (d) d.title = title
      })
    })
  })

  // Dot pulse: while the agent is responding the busy dot breathes through
  // PULSE_STEPS; when done it settles as a plain dot. Respects the global
  // `animations` setting from cli.json, read once in setup (false → static
  // dot).
  const [phase, setPhase] = createSignal(0)
  createEffect(() => {
    if (props.animations === false) {
      setPhase(0)
      return
    }
    const timer = setInterval(() => setPhase((p: number) => (p + 1) % PULSE_STEPS), PULSE_INTERVAL_MS)
    onCleanup(() => clearInterval(timer))
  })
  const busyPulse = () => {
    const p = phase() / PULSE_STEPS
    return PULSE_MIN + (1 - PULSE_MIN) * (0.5 + 0.5 * Math.cos(2 * Math.PI * p))
  }

  // Remove a session row ("×"). Closing the active session switches to the
  // next remaining session (or home when the list is empty) — the session
  // itself stays in the history, exactly like the old tab strip's close.
  const closeSession = (id: string) => {
    const list = entries()
    const idx = list.findIndex((t: Tab) => t.sessionID === id)
    if (idx === -1) return
    setStore((draft: any) => {
      draft.sessions = (draft.sessions ?? []).filter((t: Tab) => t.sessionID !== id)
    })
    if (id === activeId()) {
      const remaining = list.filter((t: Tab) => t.sessionID !== id)
      const next = remaining[idx] ?? remaining[idx - 1]
      if (next) ctx.ui.router.navigate({ type: "session", sessionID: next.sessionID })
      else ctx.ui.router.navigate({ type: "home" })
    }
  }

  // "+" row: create a session on the server, then switch to it. No manual
  // store write here — the route-tracking effect appends every session the
  // router navigates to, and writing the store separately races with that
  // (plus the cross-window storage sync), producing duplicate rows. The
  // in-flight guard keeps a double-click from creating two sessions.
  let creating = false
  const createSession = async () => {
    if (creating) return
    creating = true
    try {
      const result: any = await ctx.client.session.create({ title: "New session" })
      const id = (result?.data?.id ?? result?.id) as string | undefined
      if (!id) throw new Error("server returned no session id")
      // root() can be undefined until the data layer syncs the new session.
      const sessionID = ((ctx.data.session.root(id) as string | undefined) ?? id)
      ctx.ui.router.navigate({ type: "session", sessionID })
    } catch (error) {
      ctx.ui.toast.show({
        title: "Sessions sidebar",
        message: `Could not create session: ${error instanceof Error ? error.message : String(error)}`,
        variant: "warning",
      })
    } finally {
      creating = false
    }
  }

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme().text.base}>
        <b>Sessions</b>
        <span style={{ fg: theme().text.muted }}> ({entries().length})</span>
      </text>
      {entries().map((entry: Tab) => {
        const status = statusOf(
          ctx,
          entry.sessionID,
          theme(),
          busyPulse(),
          activeId() === entry.sessionID ? theme().text.base : theme().text.muted,
        )
        const title =
          (ctx.data.session.get(entry.sessionID)?.title as string | undefined) ?? entry.title ?? "New session"
        const shown = clipTitle(title, TITLE_MAX)
        const active = entry.sessionID === activeId()
        return (
          <box flexDirection="row" gap={1} minWidth={0}>
            <text fg={status.fg} flexShrink={0}>
              {status.char}
            </text>
            <text
              fg={active ? theme().text.base : theme().text.muted}
              attributes={active ? { bold: true } : undefined}
              wrapMode="none"
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              onMouseUp={() => ctx.ui.router.navigate({ type: "session", sessionID: entry.sessionID })}
            >
              {active ? <b>{shown}</b> : shown}
            </text>
            <text
              fg={theme().text.muted}
              flexShrink={0}
              onMouseUp={() => closeSession(entry.sessionID)}
            >
              {"\u00D7"}
            </text>
          </box>
        )
      })}
      <box flexDirection="row" justifyContent="center">
        <text
          fg={theme().text.muted}
          onMouseUp={() => void createSession()}
        >
          {"+"}
        </text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "sessions-sidebar",
  setup(context) {
    // Own the top strip for as long as the plugin is installed: force
    // `tabs.mode` off now, and keep it off across restarts and settings
    // changes. No value is ever restored while the plugin remains installed;
    // after uninstalling, re-enable the strip in Settings.
    let active = true
    let watcher: ReturnType<typeof watch> | undefined
    let assertTimer: ReturnType<typeof setTimeout> | undefined

    if (process.env.OPENCODE_CLI_CONFIG_CONTENT) {
      // Config supplied inline overrides the file, so editing it is futile.
      context.ui.toast.show({
        title: "Sessions sidebar",
        message: "Config supplied inline — the built-in tab strip cannot be hidden automatically.",
        variant: "warning",
      })
    } else {
      const result = modifyCliJson((json) => {
        if (tabsAreOff(json.tabs)) return false
        json.tabs = { ...(json.tabs ?? {}), mode: "off" }
        // Never leave the legacy key contradicting the mode we just set.
        delete json.tabs.enabled
        return true
      })
      if (result === "missing") {
        // Fresh setup: create a minimal cli.json so the strip can be hidden.
        try {
          const file = locateCliJson()
          mkdirSync(dirname(file), { recursive: true })
          writeJsonAtomic(
            file,
            JSON.stringify({ $schema: "https://opencode.ai/v2/cli.json", tabs: { mode: "off" } }, null, 2) + "\n",
          )
        } catch {}
      } else if (result === "unparsable") {
        context.ui.toast.show({
          title: "Sessions sidebar",
          message: 'Could not parse cli.json — hide the tab strip manually with tabs.mode: "off".',
          variant: "warning",
        })
      }

      // Keep the strip off while installed. The TUI re-reads cli.json on
      // every file change (its own watcher), and our own re-assert resolves
      // as "unchanged" when the mode is already off, so this watching/writing
      // pair cannot loop. This is also what overrides the settings dialog:
      // the dialog toggles the same key, and the change snaps back here.
      try {
        watcher = watch(dirname(locateCliJson()), { persistent: false }, (_event, name) => {
          if (name && basename(name).toLowerCase() !== "cli.json") return
          if (!active) return
          clearTimeout(assertTimer)
          assertTimer = setTimeout(() => {
            if (!active) return
            modifyCliJson((json) => {
              if (tabsAreOff(json.tabs)) return false
              json.tabs = { ...(json.tabs ?? {}), mode: "off" }
              delete json.tabs.enabled
              return true
            })
          }, 150)
        })
      } catch {}
    }

    // ui.slot() returns a disposer. It has to be captured and called on
    // cleanup, otherwise the Sessions block stays mounted after the plugin is
    // disabled.
    const animations = readAnimations()
    const disposeSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => <SessionsBlock context={context} animations={animations} />,
    })

    // Stop watching and unmount, but touch nothing on disk: while the plugin
    // is installed the strip stays forced off — even when the last window
    // closes. Only uninstalling (or re-enabling it in Settings) gives the
    // strip back.
    return () => {
      active = false
      disposeSlot()
      clearTimeout(assertTimer)
      watcher?.close()
      watcher = undefined
    }
  },
})
