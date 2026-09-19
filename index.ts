// Server-side no-op entrypoint. The real functionality lives in ./tui.tsx
// (loaded by the OpenCode TUI via the "./tui" export). This entrypoint exists
// so the server plugin loader can resolve the package cleanly without
// touching TUI-only dependencies. Deliberately import-free: local plugin
// entrypoints are loaded with a minimal module map on the server, so we keep
// this file dependency-free.
export default {
  id: "sessions-sidebar",
  async setup() {
    // No server behavior.
  },
}
