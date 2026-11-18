# Hermes

This adapter is experimental; see [Guidance delivery and limits](#guidance-delivery-and-limits).

Merge `config.yaml` into your Hermes configuration, replacing `/absolute/path/to/agent-atexit` with this checkout. Build the portable plugin first with `bun run build`, and copy `plugins/atexit/skills/defer-cleanup` into `$HERMES_HOME/skills/`. Export `HERMES_HOME` (normally `~/.hermes`), or replace its references in the config with an absolute path. Hermes filters inherited MCP environment variables, so configure the same state directory explicitly for both MCP and hooks.

Use Hermes 0.21.4 or newer. The template sets `skills.auto_load: [defer-cleanup]`, so `hermes chat` loads the installed skill into each new session without an extra CLI flag or a system-prompt patch. Merge this entry with any existing auto-loaded skills. Missing or disabled skills are skipped, and `--ignore-rules` / `HERMES_IGNORE_RULES=1` suppresses auto-loading. Changes take effect in a new session. Older releases can explicitly preload the skill with `hermes chat -s defer-cleanup`.

Skill loading and MCP tool visibility are separate. Hermes 0.21.4 defers MCP tool descriptions and ignores `anthropic/alwaysLoad`, so auto-loading the skill does not guarantee that atexit tools are visible in the first request. Tool discovery follows Hermes's native behavior. Hermes 0.21.4 rejects shortened MCP names such as `atexit_register`; calls must use the exposed name, such as `mcp__atexit__atexit_register`.

Hermes passes registration results to `post_tool_call`; `on_session_finalize` drains the same session. Do not use `on_session_end`: it fires after each turn while resources may still be needed.

`plugins.hook_callback_timeout: 0` makes plugin callbacks run on their caller threads. Hermes 0.21.3 otherwise skips overlapping invocations of the same callback, which can lose a registration's session binding during parallel tool calls. This setting affects all plugin callbacks; the shell hooks above still enforce their own three-second command timeout.

Use the host's session-finalization lifecycle. Hermes 0.23.1 passed an interactive `hermes chat --cli --accept-hooks` → `/quit` smoke test on a clean upstream release. Its `chat --oneshot --cli` path left registrations pending after exit and gateway shutdown, so it does not currently provide a verified cleanup boundary. Hermes 0.21.3's separate top-level `hermes -z PROMPT` path also skips `on_session_finalize`.

Automatic background reviews can still be in flight when quiet one-shot sessions finalize; this adapter does not manage their requests or SDK clients.

Use a fresh session ID after finalization. Resuming a finalized session ID is unsupported: its closed state causes newly bound cleanup to execute immediately. Hermes's `on_session_start` is tied to prompt construction and can be skipped when restoring a cached prompt, so adding that hook alone does not provide a reliable reopen boundary.

## Guidance delivery and limits

The shared skill and tool descriptions provide the cleanup rules. Hermes 0.21.4's native [`skills.auto_load`](https://github.com/NousResearch/hermes-agent/blob/d337b736aa1e8ebecfab043842d13e4a2d2f48a3/website/docs/user-guide/configuration.md#L793-L802) is the documented way to load installed skills through Hermes's own prompt lifecycle. The adapter uses native configuration, MCP and hooks; installation does not require modifying Hermes source.

The MCP command selects `--hermes` metadata for compatibility, but Hermes 0.21.4 does not pass `initialize.instructions` to the model. Those server instructions are not the guidance delivery path for this setup.

The [native smoke record](../../docs/testing.md#native-smoke-results) distinguishes clean-release lifecycle checks from model behavior. The 0.23.1 probe explicitly requested registration and verified the cleanup on disk; it does not validate autonomous resource recognition or batching.
