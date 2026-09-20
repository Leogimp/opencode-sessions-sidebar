/**
 * TUI plugin:
 * 1. Renders open sessions as a "Sessions" block at the bottom of the
 *    sidebar content area (sidebar.content). The sidebar.footer directory
 *    indicator stays below it. Rows: status icon + title, active session
 *    highlighted; click a row to switch to that session. A centered "+" row
 *    below the list creates a new session and switches to it.
 * 2. Owns the built-in top tab strip: setup sets cli.json `tabs.enabled:
 *    false`, keeps re-asserting that value while the plugin is active
 *    (another OpenCode window exiting restores it — plugin cleanup runs on
 *    every TUI shutdown — and the settings dialog can re-enable it), and the
 *    cleanup returned from setup restores the previous value when the plugin
 *    is disabled. Session tracking and navigation are handled by this plugin
 *    itself, because the built-in tab store stops tracking when the strip is
 *    disabled.
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
// While the plugin is enabled it owns `tabs.enabled`: setup turns the strip
// off (remembering the previous value in plugin storage) and the cleanup
// function returned from setup restores it when the plugin is disabled or
// unloaded. "never" means the plugin never flipped the value (it was already
// off — e.g. set manually), so cleanup leaves it alone.

type StripPref = { previous: "never" | "unset" | boolean }

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
  // PULSE_STEPS; when done it settles as a plain dot. Honors the
  // `animations` config (false → static dot).
  const [phase, setPhase] = createSignal(0)
  createEffect(() => {
    const enabled = (ctx.data.animations ?? true) !== false
    if (!enabled) {
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
    // Own the top strip: disable it and remember the previous value so the
    // cleanup (returned below) can put it back when the plugin is disabled.
    const [prefStore, setPref] = context.storage.store("strip-pref", {
      initial: { previous: "never" as StripPref["previous"] },
    })
    let prefWrite: Promise<unknown> | undefined
    // True while this activation owns the strip: setup flipped
    // `tabs.enabled` (or claimed an already-off value written by an earlier
    // version) and the watcher below keeps it off.
    let owns = false
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
        const current = json.tabs?.enabled
        if (current === false) {
          // Already off. Bootstrap the preference when this plugin wrote that
          // value in an earlier version and never stored it.
          if ((prefStore as any).previous === "never") {
            owns = true
            prefWrite = setPref((draft: StripPref) => {
              draft.previous = "unset"
            })
          }
          return false
        }
        const previous = typeof current === "boolean" ? current : "unset"
        owns = true
        prefWrite = setPref((draft: StripPref) => {
          draft.previous = previous
        })
        json.tabs = { ...(json.tabs ?? {}), enabled: false }
        return true
      })
      if (result === "missing") {
        // Fresh setup: create a minimal cli.json so the strip can be hidden.
        try {
          const file = locateCliJson()
          mkdirSync(dirname(file), { recursive: true })
          writeJsonAtomic(
            file,
            JSON.stringify({ $schema: "https://opencode.ai/v2/cli.json", tabs: { enabled: false } }, null, 2) + "\n",
          )
          owns = true
          prefWrite = setPref((draft: StripPref) => {
            draft.previous = "unset"
          })
        } catch {}
      } else if (result === "unparsable") {
        context.ui.toast.show({
          title: "Sessions sidebar",
          message: "Could not parse cli.json — hide the tab strip manually with tabs.enabled: false.",
          variant: "warning",
        })
      }

      // Keep owning the strip while active. Plugin cleanup also runs on TUI
      // shutdown, so every other OpenCode window sees `tabs.enabled` restored
      // when one window exits — and every running TUI watches cli.json, so
      // re-writing the value re-hides the strip everywhere within ~150 ms.
      if (owns) {
        try {
          watcher = watch(dirname(locateCliJson()), { persistent: false }, (_event, name) => {
            if (name && basename(name).toLowerCase() !== "cli.json") return
            if (!active || !owns) return
            clearTimeout(assertTimer)
            assertTimer = setTimeout(() => {
              if (!active || !owns) return
              modifyCliJson((json) => {
                const current = json.tabs?.enabled
                if (current === false) return false
                json.tabs = { ...(json.tabs ?? {}), enabled: false }
                return true
              })
            }, 150)
          })
        } catch {}
      }
    }

    const restoreStrip = async () => {
      active = false
      clearTimeout(assertTimer)
      watcher?.close()
      watcher = undefined
      if (process.env.OPENCODE_CLI_CONFIG_CONTENT) return
      try {
        await prefWrite
      } catch {}
      const previous = (prefStore as any).previous
      if (previous === "never" || previous === undefined) return // plugin never flipped it
      modifyCliJson((json) => {
        const tabs = { ...(json.tabs ?? {}) }
        if (previous === "unset") delete tabs.enabled
        else tabs.enabled = previous
        if (Object.keys(tabs).length === 0) delete json.tabs
        else json.tabs = tabs
        return true
      })
    }
    context.ui.slot({
      append: "sidebar.content",
      render: () => <SessionsBlock context={context} />,
    })
    return restoreStrip
  },
})
