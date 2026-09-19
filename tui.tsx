/**
 * TUI plugin:
 * 1. Renders open sessions as a "Sessions" block at the bottom of the
 *    sidebar content area (sidebar.content). The sidebar.footer directory
 *    indicator stays below it. Rows: status icon + title, active session
 *    highlighted; click a row to switch to that session.
 * 2. Hides the built-in top tab strip by setting cli.json
 *    `tabs.enabled: false` (once, when the value differs). Session tracking
 *    and navigation are handled by this plugin itself, because the built-in
 *    tab store stops tracking when the strip is disabled.
 */
/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { RGBA } from "@opentui/core"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
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

function locateCliJson(): string | undefined {
  const candidates = [
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, "opencode", "cli.json") : null,
    join(homedir(), ".config", "opencode", "cli.json"),
  ]
  return candidates.find((f) => f && existsSync(f))
}

// Parses cli.json, applies mutate(json); writes the file back when mutate
// returns true. Returns false when the file is missing or unparsable.
function modifyCliJson(mutate: (json: any) => boolean): boolean {
  const file = locateCliJson()
  if (!file) return false
  try {
    const json = JSON.parse(readFileSync(file, "utf8"))
    if (!json || typeof json !== "object") return false
    if (!mutate(json)) return false
    writeFileSync(file, JSON.stringify(json, null, 2) + "\n")
    return true
  } catch {
    // Unparsable or unexpected config; leave it alone.
    return false
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
    </box>
  )
}

export default Plugin.define({
  id: "sessions-sidebar",
  setup(context) {
    // Own the top strip: disable it and remember the previous value so the
    // cleanup (returned below) can put it back when the plugin is disabled.
    const [prefStore, setPref] = context.storage.store("strip-pref", { initial: { previous: "never" as StripPref["previous"] } })
    let prefWrite: Promise<unknown> | undefined
    if (!process.env.OPENCODE_CLI_CONFIG_CONTENT) {
      modifyCliJson((json) => {
        const current = json.tabs?.enabled
        if (current === false) {
          // Already off. Bootstrap the preference when this plugin wrote that
          // value in an earlier version and never stored it.
          if ((prefStore as any).previous === "never") {
            prefWrite = setPref((draft: StripPref) => {
              draft.previous = "unset"
            })
          }
          return false
        }
        const previous = typeof current === "boolean" ? current : "unset"
        prefWrite = setPref((draft: StripPref) => {
          draft.previous = previous
        })
        json.tabs = { ...(json.tabs ?? {}), enabled: false }
        return true
      })
    }
    const restoreStrip = async () => {
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
        json.tabs = tabs
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
