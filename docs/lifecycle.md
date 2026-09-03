# Lifecycle contract

## State machine

```text
provisional -> pending -> claimed -> running -> succeeded | failed
      |           |
      +-----------+-----------------------------> cancelled
```

1. `atexit_register` persists a provisional record before returning its capability ID.
2. Native adapters bind immediately. MCP adapters use the host's `PostToolUse` payload to bind the returned registration ID to the authoritative session ID.
3. Session close is serialized with binding through a per-session filesystem lock. A binding arriving after close is claimed as a late run instead of being stranded.
4. Claim writes `claimed` to every selected registration before publishing a run record. This ordering is deliberately at-most-once: a crash may lose work but cannot make a later close claim the same action again.
5. A detached worker acquires a persistent `run.lock`, executes registrations in reverse creation order, and records command status plus output logs.

## Isolation

Raw session IDs are hashed together with the host name before they become storage keys. List requires explicit registration IDs, which are random capabilities, so one session cannot enumerate another session's command lines.

## Host-specific behavior

### Claude Code

The plugin uses a scoped MCP server and `PostToolUse`/`SessionEnd` command hooks. `SessionEnd` has a short global budget, and plugin-provided timeout fields do not increase it. `/clear` and interactive session switches have host-defined end reasons, so registrations bind to the exact `session_id` supplied by the hook rather than an MCP process environment that may outlive `/clear`.

### Codex

Codex uses the same hook script and a plugin-relative bundled MCP command. The legacy bundled-MCP format does not expose `PLUGIN_DATA` to the server, so both the MCP server and Codex hook deliberately use the XDG state fallback. A task switch does not immediately close a thread; `SessionEnd` fires when the root thread is closed, archived, deleted, or unloaded after the documented idle period. Plugin hooks require hash-based user trust. SessionEnd is synchronous and capped at three seconds.

### Kimi Code

Kimi's workspace MCP connection is not session-scoped and tool calls carry no protocol-level session ID. The adapter uses Kimi's `PostToolUse` payload to bind the returned registration ID to the authoritative session ID without adding an approval prompt. `SessionEnd` reports `exit` or `archive`. The TUI's emergency `SIGHUP` path can bypass cleanup, and non-interactive shutdown is separately bounded.

### OpenCode

The native tool context supplies `sessionID`, so no MCP binding bridge is needed. `Hooks.dispose()` means project/directory instance unload, not logical session end; a single instance can own multiple sessions. `session.deleted` means permanent deletion, while deprecated `session.idle` fires after turns and is never treated as exit. Desktop and attached/long-lived server paths can outlive a client, so the adapter does not claim full process-exit coverage.

### dsh

The native tool context supplies an owning Agent. The adapter installs exactly one async disposer in that Agent's `ctx.effect`; individual actions are kept inside that disposer and drained serially because separate Cordis effects may complete concurrently. In profiles with the workspace domain, a durable `domain/changed` event also drains a session when its ID enters `archivedSessionIds`; `session/disposed` is an additional idempotent fallback. Registration does not add an approval prompt by default; set the plugin's `ask` config to `true` to make `tools/pre-execute` return `ask` for `atexit_register`.
