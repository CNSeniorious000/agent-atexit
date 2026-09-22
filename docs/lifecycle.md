# Lifecycle contract

## State machine

```text
provisional -> pending -> claimed -> running -> succeeded | failed
      |           |
      +-----------+-----------------------------> cancelled
```

1. `atexit_register` persists a provisional record before returning its capability ID.
2. Native adapters bind immediately. MCP adapters use the host's post-tool payload to bind the returned registration ID to the authoritative session ID.
3. Session close is serialized with binding through a per-session filesystem lock. A binding arriving after close is claimed as a late run instead of being stranded.
4. Claim writes `claimed` to every selected registration before publishing a run record. This ordering is deliberately at-most-once: a crash may lose work but cannot make a later close claim the same action again.
5. A detached worker acquires a persistent `run.lock`, executes registrations in reverse creation order, and records command status plus output logs.

## Isolation

Raw session IDs are hashed together with the host name before they become storage keys. List requires explicit registration IDs, which are random capabilities, so one session cannot enumerate another session's command lines.

## Host-specific behavior

### Claude Code

The plugin uses a scoped MCP server and `SessionStart`/`PostToolUse`/`SessionEnd` command hooks. Claude selects its guidance with `--claude`. A Claude-only `PostToolBatch` hook repeats it once after substantive tool work, with source-location hints when authored commands or code appear to discard errors. These hints are advisory, not shell parsing or proof of release; they do not quote source text or inspect tool results. The hook adds context to the next request without a separate model invocation or changing registration ownership. `SessionEnd` has a short global budget, and plugin-provided timeout fields do not increase it. `/clear` and interactive session switches have host-defined end reasons, so registrations bind to the exact `session_id` supplied by the hook rather than an MCP process environment that may outlive `/clear`.

### Codex

Codex uses the same hook script and a plugin-relative bundled MCP command. The legacy bundled-MCP format does not expose `PLUGIN_DATA` to the server, so both the MCP server and Codex hook deliberately use the XDG state fallback. [SessionStart](https://learn.chatgpt.com/docs/hooks#sessionstart) explicitly opens or resumes cleanup ownership; duplicate starts while open preserve that ownership. [SessionEnd](https://learn.chatgpt.com/docs/hooks#sessionend) is root-only and fires on normal app exit, when an open conversation is archived or deleted, or after a closed thread has been idle for 30 minutes. Subagent hooks share the parent `session_id`. Plugin hooks require hash-based user trust. SessionEnd is synchronous and capped at three seconds.

Registrations and true reopen boundaries use permanent sequence tickets, not timestamps or a global allocator lock. Tickets are permanent filesystem entries; their count grows with registrations and reopens, and a regressed hint costs extra probes over existing tickets. A first SessionStart creates no reopen boundary. A delayed registration with a known pre-resume sequence is claimed alone and cannot replace a new same-key fallback. Records from older MCP servers have no comparable sequence: while the session is open, they remain pending until cancellation or SessionEnd and cannot replace another fallback. Their original incarnation cannot be recovered from the old format. Hooks also supply no incarnation token: an old tool that only creates its registration after resume, or an old SessionEnd delivered after the new SessionStart, cannot be distinguished from the new incarnation by session ID alone.

### Kimi Code

Kimi's workspace MCP connection is not session-scoped and tool calls carry no protocol-level session ID. The adapter uses Kimi's `PostToolUse` payload to bind the returned registration ID to the authoritative session ID without adding an approval prompt. `SessionEnd` reports `exit` or `archive`. The TUI's emergency `SIGHUP` path can bypass cleanup, and non-interactive shutdown is separately bounded.

### OpenCode

The native tool context supplies `sessionID`, so no MCP binding bridge is needed. `Hooks.dispose()` means project/directory instance unload, not logical session end; a single instance can own multiple sessions. `session.deleted` means permanent deletion, while deprecated `session.idle` fires after turns and is never treated as exit. Desktop and attached/long-lived server paths can outlive a client, so the adapter does not claim full process-exit coverage.

### dsh

The native tool context supplies an owning Agent. The adapter installs exactly one async disposer in that Agent's `ctx.effect`; individual actions are kept inside that disposer and drained serially because separate Cordis effects may complete concurrently. In profiles with the workspace domain, a durable `domain/changed` event also drains a session when its ID enters `archivedSessionIds`; `session/disposed` is an additional idempotent fallback. Registration does not add an approval prompt by default; set the plugin's `ask` config to `true` to make `tools/pre-execute` return `ask` for `atexit_register`.

### Hermes

Shell hooks bind `post_tool_call` results using Hermes's session ID and drain at `on_session_finalize`. `on_session_end` is a turn boundary and never triggers cleanup. Hermes 0.21.3's `hermes chat --oneshot` uses the supported chat lifecycle; its separate top-level `hermes -z PROMPT` path skips finalization. The [adapter configuration](../adapters/hermes/config.yaml) explicitly shares the state directory because MCP filters inherited environment variables. It disables Hermes's outer callback timeout to prevent concurrent callback suppression; each shell command retains its own timeout. This changes callback execution for all plugins in the configured profile.

Resuming a finalized session ID is unsupported: its closed state makes newly bound cleanup run immediately. Start a fresh session instead. Hermes can restore a cached prompt without emitting `on_session_start`, so that event alone cannot reopen ownership reliably. Automatic background reviews can still be in flight when quiet one-shot sessions finalize; this adapter does not manage their requests or SDK clients.
