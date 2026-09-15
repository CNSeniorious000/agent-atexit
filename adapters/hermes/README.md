# Hermes

Merge `config.yaml` into your Hermes configuration, replacing `/absolute/path/to/agent-atexit` with this checkout. Build the portable plugin first with `bun run build`, and copy `plugins/atexit/skills/defer-cleanup` into `$HERMES_HOME/skills/`. Export `HERMES_HOME` (normally `~/.hermes`), or replace its references in the config with an absolute path. Hermes filters inherited MCP environment variables, so configure the same state directory explicitly for both MCP and hooks.

Start sessions with `hermes chat -s defer-cleanup` to preload the skill. Hermes 0.21.3 defers MCP tool descriptions and does not honor the server's `alwaysLoad` metadata; copying the skill alone leaves its use to discovery. The supported preload option is `-s`; this version has no `skills.preload` configuration key.

Hermes passes registration results to `post_tool_call`; `on_session_finalize` drains the same session. Do not use `on_session_end`: it fires after each turn while resources may still be needed.

`plugins.hook_callback_timeout: 0` makes plugin callbacks run on their caller threads. Hermes 0.21.3 otherwise skips overlapping invocations of the same callback, which can lose a registration's session binding during parallel tool calls. This setting affects all plugin callbacks; the shell hooks above still enforce their own three-second command timeout.

Verified entry point: `hermes chat -s defer-cleanup --oneshot --query-file prompt.txt --accept-hooks`. Hermes 0.21.3's separate top-level `hermes -z PROMPT` path does not emit `on_session_finalize`, so deferred cleanup is not supported on that path.
