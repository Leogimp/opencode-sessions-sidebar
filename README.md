# @leogimp/opencode-sessions-sidebar

[OpenCode](https://opencode.ai) v2 TUI plugin that renders open sessions as a **Sessions** block at the bottom of the sidebar - click a row to switch sessions, `×` to close one - and replaces the built-in top tab strip. Fully reversible: disabling the plugin unmounts the block and gives you your tab strip back.

<div align="center">

<img src="https://img.shields.io/badge/TypeScript-000000?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
<img src="https://img.shields.io/badge/SolidJS-000000?style=for-the-badge&logo=solid&logoColor=white" alt="SolidJS" />
<img src="https://img.shields.io/badge/OpenTUI-000000?style=for-the-badge&logo=opencode&logoColor=white" alt="OpenTUI" />

<br />

<img src="https://img.shields.io/badge/opencode-2.0.0-000000?style=for-the-badge&logo=opencode&logoColor=white" alt="opencode 2.0.0" />
<img src="https://img.shields.io/badge/License-MIT-000000?style=for-the-badge&logo=open-source-initiative&logoColor=white" alt="MIT License" />

<br />

<a href="https://www.buymeacoffee.com/leogimpel"><img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-000000?style=for-the-badge&logo=buymeacoffee&logoColor=white" alt="Buy Me A Coffee" /></a>

</div>

## Install

This is a TUI (CLI-only) plugin, so it belongs in **`cli.json`** under the **`plugins`** key - not in `opencode.json(c)`, and not in a `tui.json`. `tui.json` was the OpenCode v1 layout and is not read by v2.

### From npm (recommended)

```bash
opencode plugin add @leogimp/opencode-sessions-sidebar
```

Or add it by hand to `~/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["@leogimp/opencode-sessions-sidebar"]
}
```

> [!IMPORTANT]
> The npm package is **scoped to `@leogimp`**. The unscoped `opencode-sessions-sidebar` name on npm belongs to a different, unrelated plugin by another author - installing that name gets you their plugin, not this one.

### From source

Point `plugins` at the checkout:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["C:\\path\\to\\sessions-sidebar"]
}
```

Relative paths (`./plugins/sessions-sidebar`), `file://` URLs, and dropping the folder into `~/.config/opencode/plugins/` all work too. The published tarball ships the TypeScript sources as-is - there is no build step to run.

### Uninstall

```bash
opencode plugin remove @leogimp/opencode-sessions-sidebar
```

Or delete the entry from `cli.json`. Either way the cleanup runs, the Sessions block is unmounted, and the built-in tab strip is restored.

To turn the plugin off temporarily without uninstalling it, prefix its id with `-` (`opencode plugin list` shows the ids in use):

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["-sessions-sidebar"]
}
```

`cli.json` is watched, so config changes are picked up without restarting OpenCode. Edits to the plugin's own source files are not watched - restart the TUI after changing them.

## Features

<div align="center">

<img src="https://raw.githubusercontent.com/Leogimp/opencode-sessions-sidebar/main/assets/sidebar.png" alt="Sessions block in the opencode TUI sidebar" width="400" />

</div>

### Sessions block

A live list of open sessions appended to the bottom of the sidebar content area,
above the built-in footer directory indicator:

- One row per session: **status icon + title**, the active session highlighted in bold
- **Click a row to switch** to that session, click **`×`** to remove it from the list
- A centred **`+`** row creates a new session and switches to it
- Closing the active session switches to the next remaining session (or home when the
  list is empty) - the session itself stays in the history, exactly like the old tab strip's close
- Tracks up to **10 sessions**, newest at the bottom; the order is append-only, so rows
  never shuffle while you work
- Session titles persist in the plugin's store, so they survive data eviction

### Status indicators

Each row's icon mirrors the built-in tab strip logic, across the session and its whole
subagent family:

- **Busy** - a dot that gently breathes (smooth cosine pulse) while the agent is
  responding or has pending work; static when `animations` is set to `false` in
  `cli.json` (read once at startup)
- **Attention** - a warning-coloured triangle when the session has pending
  permissions or questions
- **Idle** - a plain dot otherwise

### Tab strip ownership

While the plugin is enabled it hides the built-in top tab strip by setting
`tabs.mode: "off"` in `cli.json` (session tracking moves into the
plugin, because the built-in tab store stops tracking once the strip is disabled):

- The previous `tabs` setting is remembered in plugin storage
- While the plugin is running it **keeps re-asserting** `tabs.mode: "off"` by
  watching the config file - plugin cleanup also runs when any OpenCode window
  exits, which would otherwise re-enable the strip in every window that is
  still open
- Disabling or removing the plugin **restores the strip** automatically, putting
  `tabs` back exactly as it was - including sibling keys like `layout` and `scope`
- The plugin writes `mode` and deletes the legacy `enabled` boolean while it holds
  the strip, so the two can never disagree. If the strip was *already* off when the
  plugin started, it assumes an earlier install of itself turned it off, records
  "no explicit setting", and cleanup drops the key so the strip returns to
  OpenCode's `auto` default
- `cli.json` is resolved like OpenCode does (`OPENCODE_CONFIG_DIR`, then
  `XDG_CONFIG_HOME`, then `~/.config/opencode`) and is created when missing;
  writes are atomic (temp + rename). If the file cannot be parsed (e.g. JSONC
  comments), a toast asks you to hide the strip manually

## Notes

- The sidebar row width is fixed by OpenCode's sidebar layout; long titles are
  clipped with a trailing ellipsis.
- `index.ts` is a deliberate no-op so the server-side plugin loader resolves the
  package cleanly without pulling TUI-only dependencies into the server module
  map - all rendering lives in `tui.tsx`, which is what the `./tui` export loads.
- `@opencode/plugin`, `solid-js`, `@opentui/core` and `@opentui/solid` are declared
  as real dependencies so the bare specifiers resolve inside OpenCode's plugin
  install cache. `solid-js` tracks the version `@opentui/solid` is built against
  rather than the stale exact pin, which avoids shipping a second copy of it.

## Requirements

- OpenCode **2.0.0+** (uses the V2 TUI plugin slot API and `cli.json`)

## License

[MIT](LICENSE)