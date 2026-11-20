/**
 * TUI plugin:
 * 1. Renders open sessions as a "Sessions" block at the bottom of the
 *    sidebar content area (sidebar.content). The sidebar.footer directory
 *    indicator stays below it. Rows: status icon + title, active session
 *    highlighted; click a row to switch to that session. A "+" row below
 *    the list creates a new session and switches to it.
 * 2. Owns the built-in top tab strip: while the plugin is installed,
 *    `tabs.mode` stays forced to "off" — setup sets it, a watcher re-asserts
 *    it whenever the file changes (the settings dialog toggles the same
 *    key, and the TUI re-reads cli.json live, so a dialog change snaps back
 *    within ~150 ms), and nothing restores a previous value while the
 *    plugin remains installed. After uninstalling, re-enable the strip in
 *    Settings. Session tracking and navigation are handled by this plugin
 *    itself, because the built-in tab store stops tracking when the strip
 *    is disabled — including its keymap layer, which this plugin replaces
 *    with its own session-switching keys.
 * 3. Subscribes to server events so the list stays truthful no matter
 *    where a change came from: `session.deleted` prunes rows for sessions
 *    deleted from any window (and navigates away if the deleted session
 *    was being viewed), `session.renamed` keeps stored fallback titles
 *    fresh, and every store mutation is idempotent and re-checked against
 *    the on-disk draft so cross-window writes cannot duplicate or drop
 *    rows.
 */
/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, untrack } from "solid-js"
import { RGBA, TextAttributes } from "@opentui/core"
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
// Status glyphs use distinct shapes (not just colors) so busy / attention /
// unread / idle stay readable on monochrome or color-blind terminals:
//   "!" pending permission, "?" pending question, "●" busy (breathing),
//   "•" unread activity, "○" idle.
const ICON = { busy: "\u25CF", unread: "\u2022", idle: "\u25CB" }
// Busy dots breathe smoothly (cosine curve, ~1.2s cycle) while the agent
// is responding; static at full brightness when animations are disabled.
const PULSE_STEPS = 24
const PULSE_INTERVAL_MS = 50
const PULSE_MIN = 0.15
// Background rows (restored from the persisted store after a restart, or
// appended by another window) are synced with the server once, shortly
// after mount, so their status and titles are live without visiting them.
const BACKGROUND_SYNC_DELAY_MS = 250
// Untitled sessions get a server-side "New session - <timestamp>" title;
// the sidebar collapses that pattern into a compact relative-time label.
const UNTITLED_TITLE = /^(?:New|Child) session - /
// Keyboard parity with the built-in strip: ctrl+1..9 select rows 1-9,
// ctrl+0 selects row 10.
const SELECT_BINDS = ["ctrl+1", "ctrl+2", "ctrl+3", "ctrl+4", "ctrl+5", "ctrl+6", "ctrl+7", "ctrl+8", "ctrl+9", "ctrl+0"]

type Tab = { sessionID: string; title?: string; created?: number }

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
// which cuts head+tail in the middle. Clipping counts display columns, not
// code points, so CJK/emoji titles (width-2 glyphs) cannot blow out the
// row.
const TITLE_MAX = 32

// Terminal display width of one code point: 0 for combining marks, 2 for
// East Asian wide/fullwidth and emoji-presentation ranges, 1 otherwise.
function charWidth(code: number): number {
  if (code >= 0x0300 && code <= 0x036f) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

function clipTitle(value: string, max: number): string {
  const chars = Array.from(value)
  const widths = chars.map((ch) => charWidth(ch.codePointAt(0) ?? 0))
  const total = widths.reduce((sum, w) => sum + w, 0)
  if (total <= max) return value
  let width = 0
  let cut = 0
  for (let i = 0; i < chars.length; i++) {
    const w = widths[i] ?? 1
    if (width + w > max - 1) break
    width += w
    cut = i + 1
  }
  return chars.slice(0, cut).join("") + "\u2026"
}

// Compact relative age for untitled sessions, e.g. "New session · 3m".
function relativeTime(created: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - created) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
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

// Family members for status checks. The data layer can return an empty list
// before the session's info is synced (fresh TUI start, restored rows,
// post-deletion) — in that case check the root itself, mirroring the
// built-in tab strip, or a running root can render as idle.
function familyOf(ctx: any, sessionID: string): string[] {
  const members: string[] = ctx.data.session.family(sessionID) ?? []
  return members.includes(sessionID) ? members : [sessionID, ...members]
}

// Busy when any family member is running or has pending work (mirrors the
// built-in tab strip logic).
function sessionBusy(ctx: any, family: string[]): boolean {
  return family.some(
    (id) =>
      ctx.data.session.status(id) === "running" ||
      (ctx.data.session.pending.list(id) ?? []).some((p: any) => p.type !== "synthetic"),
  )
}

// Attention on pending permissions (shown as "!") or question forms (shown
// as "?"), permissions first like the built-in strip.
function sessionAttention(ctx: any, family: string[]): "permission" | "question" | false {
  if (family.some((id) => (ctx.data.session.permission.list(id)?.length ?? 0) > 0)) return "permission"
  if (family.some((id) => (ctx.data.session.form.list(id)?.length ?? 0) > 0)) return "question"
  return false
}

function SessionRow(props: any) {
  const ctx = props.context
  const theme = () => ctx.theme
  const id = () => props.tab.sessionID as string
  const active = () => id() === props.activeId()
  const info = () => ctx.data.session.get(id())
  const family = () => familyOf(ctx, id())
  const busy = () => sessionBusy(ctx, family())
  const attention = () => sessionAttention(ctx, family())
  // Unread: the session finished working after it was last viewed (and it
  // is not the one being viewed right now).
  const unread = () => {
    if (active()) return false
    const time = info()?.time
    return !!time?.idle && !!time.viewed && time.idle > time.viewed
  }
  // The pulse signal is only read while the row is busy, so idle rows never
  // subscribe to the animation ticker.
  const status = () => {
    if (attention() === "permission") return { char: "!", fg: theme().text.feedback.warning.base }
    if (attention() === "question") return { char: "?", fg: theme().text.feedback.warning.base }
    if (busy()) return { char: ICON.busy, fg: dimColor(theme().hue.accent[200], props.pulse()) }
    if (unread()) return { char: ICON.unread, fg: theme().hue.accent[200] }
    return { char: ICON.idle, fg: active() ? theme().text.base : theme().text.muted }
  }
  const title = () => {
    const raw = (info()?.title as string | undefined) ?? props.tab.title
    if (raw && !UNTITLED_TITLE.test(raw)) return raw
    const created = info()?.time?.created ?? props.tab.created
    return created ? `New session \u00B7 ${relativeTime(created)}` : "New session"
  }
  const shown = () => clipTitle(title(), TITLE_MAX)
  return (
    <box flexDirection="row" gap={1} minWidth={0}>
      <text fg={status().fg} flexShrink={0}>
        {status().char}
      </text>
      <text
        fg={active() ? theme().text.base : theme().text.muted}
        attributes={active() ? TextAttributes.BOLD : undefined}
        wrapMode="none"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        onMouseUp={() => ctx.ui.router.navigate({ type: "session", sessionID: id() })}
      >
        {active() ? <b>{shown()}</b> : shown()}
      </text>
      {/* The leading space is part of the glyph's own cells, so the click
          target covers the visual gap next to the ×, not just the glyph. */}
      <text fg={active() ? theme().text.base : theme().text.muted} flexShrink={0} onMouseUp={() => props.onClose(id())}>
        {" \u00D7"}
      </text>
    </box>
  )
}

function SessionsBlock(props: any) {
  const ctx = props.context
  const theme = () => ctx.theme
  // storage.store() returns [storeObject, updateFn] — read via property
  // access on the store object, write via the updater. `key: "sessionID"`
  // makes the storage layer reconcile persisted rows by session id (the
  // same option the built-in tab store passes), so row identity survives
  // cross-window storage reloads instead of items being replaced
  // wholesale.
  const [tabStore, setStore] = ctx.storage.store("tabs", { initial: { sessions: [] }, key: "sessionID" })
  const entries = () => (tabStore.sessions ?? []) as Tab[]
  const route = () => ctx.ui.router.current()
  const activeId = () => (route()?.type === "session" ? (ctx.data.session.root(route()!.sessionID) as string) : undefined)

  // Storage writes are async (file lock + disk write). Every mutation goes
  // through update() so a failed write is logged instead of surfacing as an
  // unhandled rejection.
  const update = (mutation: (draft: any) => void) => {
    void setStore(mutation).catch((error: unknown) => {
      console.error("[sessions-sidebar] failed to persist tabs", error)
    })
  }

  // Session ids are never reused: once deleted, an id must never come back.
  // The route-tracking effect consults this set so a navigation racing a
  // deletion cannot resurrect the row (the same guard the built-in tab
  // store implements with its cancelled-tabs set).
  const deleted = new Set<string>()

  // Idempotent append. The duplicate check runs against the draft the
  // storage layer just read from disk under its file lock — not against the
  // possibly stale local snapshot — so an append racing a cross-window
  // append of the same session, or landing after a removal, is a no-op
  // instead of producing duplicate or resurrected rows. Eviction keeps the
  // newest MAX_TABS rows, never the active one; newest session lands at
  // the bottom.
  const appendTab = (id: string) => {
    const active = activeId()
    const info = ctx.data.session.get(id)
    update((draft: any) => {
      const list: Tab[] = draft.sessions ?? []
      if (list.some((t: Tab) => t.sessionID === id)) return
      let rest = list
      if (list.length >= MAX_TABS) {
        let evictable = list.length - (MAX_TABS - 1)
        rest = list.filter((t: Tab) => {
          if (evictable > 0 && t.sessionID !== active) {
            evictable--
            return false
          }
          return true
        })
      }
      draft.sessions = [...rest, { sessionID: id, title: info?.title, created: info?.time?.created ?? Date.now() }]
    })
  }

  // Capture navigation once per route change. Tracking is append-only: a
  // session keeps its row position once opened, so rows never shuffle.
  createEffect(() => {
    const r = route()
    if (!r || r.type !== "session") return
    untrack(() => {
      const root = ctx.data.session.root(r.sessionID) as string
      if (deleted.has(root)) return
      appendTab(root)
    })
  })

  // Refresh the stored title of the active session in place (used as
  // fallback once session data is evicted). Order never changes here. The
  // stored fallback is only ever overwritten with a real title — never
  // wiped back to undefined — and a missing active row is re-added, since
  // nothing else will (an eviction computed in another window can drop the
  // row that is currently being viewed).
  createEffect(() => {
    const id = activeId()
    if (!id || deleted.has(id)) return
    const title = ctx.data.session.get(id)?.title as string | undefined
    untrack(() => {
      const entry = entries().find((t: Tab) => t.sessionID === id)
      if (!entry) {
        appendTab(id)
        return
      }
      if (title === undefined || (entry.title ?? undefined) === title) return
      update((draft: any) => {
        const d = (draft.sessions ?? []).find((t: Tab) => t.sessionID === id)
        if (d) d.title = title
      })
    })
  })

  // Deleted sessions leave the list, no matter which window (or client)
  // deleted them: `session.deleted` is a durable server event delivered to
  // every connected TUI. Mirrors the built-in strip's prune: remove the row,
  // and if it was the session being viewed, switch to the neighbouring
  // session (or home when the list is empty).
  onCleanup(
    ctx.data.on("session.deleted", (event: any) => {
      const id = event.data.sessionID as string
      deleted.add(id)
      untrack(() => {
        const list = entries()
        const idx = list.findIndex((t: Tab) => t.sessionID === id)
        if (idx === -1) return
        update((draft: any) => {
          draft.sessions = (draft.sessions ?? []).filter((t: Tab) => t.sessionID !== id)
        })
        if (activeId() === id) {
          const remaining = list.filter((t: Tab) => t.sessionID !== id)
          const next = remaining[idx] ?? remaining[idx - 1]
          ctx.ui.router.navigate(next ? { type: "session", sessionID: next.sessionID } : { type: "home" })
        }
      })
    }),
  )

  // Keep the persisted fallback title fresh for renamed sessions even while
  // they are not the active one, so rows restored after a restart show the
  // current title.
  onCleanup(
    ctx.data.on("session.renamed", (event: any) => {
      const { sessionID, title } = event.data
      untrack(() => {
        update((draft: any) => {
          const d = (draft.sessions ?? []).find((t: Tab) => t.sessionID === sessionID)
          if (d) d.title = title
        })
      })
    }),
  )

  // A row can be stored under a child session id if the router ever lands
  // on a child whose info has not synced yet (root() falls back to the id
  // itself). Once the info syncs, re-key the row to the real root — or drop
  // it if the root already has a row.
  const normalize = (id: string) => {
    const root = ctx.data.session.root(id) as string
    if (root === id) return
    untrack(() => {
      update((draft: any) => {
        const list: Tab[] = draft.sessions ?? []
        const idx = list.findIndex((t: Tab) => t.sessionID === id)
        if (idx === -1) return
        if (list.some((t: Tab) => t.sessionID === root)) {
          draft.sessions = list.filter((t: Tab) => t.sessionID !== id)
        } else {
          const copy = [...list]
          copy[idx] = { ...copy[idx]!, sessionID: root }
          draft.sessions = copy
        }
      })
    })
  }

  // With the built-in strip disabled, its prefetch effect is gone too, so
  // restored rows would render with no info/status until visited. Sync each
  // tracked session once per mount (throttled, fire-and-forget), then
  // re-root it in case it was stored under a child id.
  const synced = new Set<string>()
  createEffect(() => {
    entries()
    untrack(() => {
      for (const tab of entries()) {
        const id = tab.sessionID
        if (synced.has(id)) continue
        synced.add(id)
        setTimeout(() => {
          void ctx.data.session
            .sync(id)
            .then(() => normalize(id))
            .catch(() => {
              synced.delete(id)
            })
          void ctx.data.session.pending.sync(id).catch(() => {})
          void ctx.data.session.permission.sync(id).catch(() => {})
          void ctx.data.session.form.sync(id).catch(() => {})
        }, BACKGROUND_SYNC_DELAY_MS)
      }
    })
  })

  // Dot pulse: only ticks while at least one tracked session is actually
  // busy, so a fully idle list costs nothing. While the agent is responding
  // the busy dot breathes through PULSE_STEPS; when done it settles as a
  // plain dot. Respects the global `animations` setting from cli.json,
  // read once in setup (false → static dot).
  const [phase, setPhase] = createSignal(0)
  const anyBusy = createMemo(() => entries().some((t: Tab) => sessionBusy(ctx, familyOf(ctx, t.sessionID))))
  createEffect(() => {
    if (props.animations === false || !anyBusy()) {
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
  // Closed rows are remembered so ctrl+shift+t can reopen them.
  const closedStack: Tab[] = []
  const closeSession = (id: string) => {
    const list = entries()
    const idx = list.findIndex((t: Tab) => t.sessionID === id)
    if (idx === -1) return
    closedStack.push(list[idx]!)
    if (closedStack.length > MAX_TABS) closedStack.shift()
    update((draft: any) => {
      draft.sessions = (draft.sessions ?? []).filter((t: Tab) => t.sessionID !== id)
    })
    if (id === activeId()) {
      const remaining = list.filter((t: Tab) => t.sessionID !== id)
      const next = remaining[idx] ?? remaining[idx - 1]
      if (next) ctx.ui.router.navigate({ type: "session", sessionID: next.sessionID })
      else ctx.ui.router.navigate({ type: "home" })
    }
  }

  // "+" row: create a session on the server, then switch to it. The data
  // layer is synced before navigating, so the tracking effect resolves the
  // root id and title immediately. No title is passed — the server applies
  // its untitled-session fallback and the sidebar collapses it into a
  // relative-time label. The in-flight guard keeps a double-click from
  // creating two sessions.
  const [creating, setCreating] = createSignal(false)
  const createSession = async () => {
    if (creating()) return
    setCreating(true)
    try {
      const result: any = await ctx.client.session.create({})
      const id = (result?.data?.id ?? result?.id) as string | undefined
      if (!id) throw new Error("server returned no session id")
      try {
        await ctx.data.session.sync(id)
      } catch {}
      ctx.ui.router.navigate({ type: "session", sessionID: ctx.data.session.root(id) })
    } catch (error) {
      ctx.ui.toast.show({
        title: "Sessions sidebar",
        message: `Could not create session: ${error instanceof Error ? error.message : String(error)}`,
        variant: "warning",
      })
    } finally {
      setCreating(false)
    }
  }

  // --- Keyboard session switching -----------------------------------------
  // Forcing `tabs.mode: "off"` disables the built-in strip's keymap layer
  // with it (every session.tab.* command is gated on the strip being
  // enabled), which would silently remove keyboard session switching. This
  // layer re-binds the same keys to the sidebar's list. It is disposed with
  // the reactive root that created it (this component), and plugin
  // deactivation unmounts the component.
  const cycle = (dir: number) => {
    const list = entries()
    if (!list.length) return
    const idx = list.findIndex((t: Tab) => t.sessionID === activeId())
    const next =
      idx === -1 ? (dir > 0 ? list[0] : list[list.length - 1]) : list[(idx + dir + list.length) % list.length]
    if (next) ctx.ui.router.navigate({ type: "session", sessionID: next.sessionID })
  }
  const closeActive = () => {
    const id = activeId()
    if (id) closeSession(id)
  }
  const reopen = () => {
    while (closedStack.length) {
      const tab = closedStack.pop()!
      if (deleted.has(tab.sessionID)) continue
      ctx.ui.router.navigate({ type: "session", sessionID: tab.sessionID })
      return
    }
  }
  const selectN = (n: number) => {
    const tab = entries()[n - 1]
    if (tab) ctx.ui.router.navigate({ type: "session", sessionID: tab.sessionID })
  }
  ctx.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "sessions-sidebar.next",
        title: "Next session",
        group: "Sessions",
        bind: "ctrl+tab,alt+down",
        palette: true,
        run: () => cycle(1),
      },
      {
        id: "sessions-sidebar.previous",
        title: "Previous session",
        group: "Sessions",
        bind: "ctrl+shift+tab,alt+up",
        palette: true,
        run: () => cycle(-1),
      },
      ...SELECT_BINDS.map((bind, i) => ({
        id: `sessions-sidebar.select.${i + 1}`,
        title: `Open session ${i + 1}`,
        group: "Sessions",
        bind,
        run: () => selectN(i + 1),
      })),
      {
        id: "sessions-sidebar.close",
        title: "Close current session",
        group: "Sessions",
        bind: "<leader>w",
        palette: true,
        run: () => closeActive(),
      },
      {
        id: "sessions-sidebar.reopen",
        title: "Reopen closed session",
        group: "Sessions",
        bind: "ctrl+shift+t",
        palette: true,
        run: () => reopen(),
      },
    ],
  }))

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme().text.base}>
        <b>Sessions</b>
        <span style={{ fg: theme().text.muted }}> ({entries().length})</span>
      </text>
      <For each={entries()}>
        {(tab) => <SessionRow context={ctx} tab={tab} activeId={activeId} pulse={busyPulse} onClose={closeSession} />}
      </For>
      {entries().length === 0 && <text fg={theme().text.muted}>No open sessions</text>}
      <box flexDirection="row">
        <text
          fg={creating() ? theme().text.base : theme().text.muted}
          flexShrink={0}
          onMouseUp={() => void createSession()}
        >
          {creating() ? "+ Creating session\u2026" : "+ New session"}
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
    }

    // ui.slot() returns a disposer. It has to be captured and called on
    // cleanup, otherwise the Sessions block stays mounted after the plugin is
    // disabled. The slot is claimed BEFORE the config watcher is created, so
    // a failed claim cannot leak a watcher that keeps re-asserting
    // tabs.mode forever.
    const animations = readAnimations()
    const disposeSlot = context.ui.slot({
      append: "sidebar.content",
      render: () => <SessionsBlock context={context} animations={animations} />,
    })

    if (!process.env.OPENCODE_CLI_CONFIG_CONTENT) {
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
