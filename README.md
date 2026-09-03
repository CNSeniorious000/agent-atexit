# agent-atexit

`agent-atexit` gives coding agents a small, explicit cleanup registry. An agent can register literal `argv` commands during a session, inspect or cancel them by capability ID, and have pending commands launched when the host's supported exit lifecycle fires.

> [!WARNING]
> This project is pre-release. Registering a command authorizes delayed execution with your user account's permissions. The adapters do not add an approval prompt by default; host permission policy still applies.

## Tools

- `atexit_register({ argv, cwd?, key?, timeout_ms? })` registers one command without invoking a shell. A newer pending command with the same `key` replaces the older one in that session.
- `atexit_cancel({ registration_id })` cancels a provisional or pending command.
- `atexit_list({ registration_ids })` inspects only the capability IDs supplied by the caller, preventing cross-session enumeration.

The core persists registrations before returning success, binds them to the host's real session identity, atomically claims them at exit, and writes one log per command. Claimed runs carry a durable run lock: after a crash, the project prefers a missed cleanup over executing an arbitrary command twice.

## Host support

| Host | Tool integration | Exit trigger | Current guarantee |
| --- | --- | --- | --- |
| Claude Code | bundled MCP server | `SessionEnd` | Clean session exits; plugin hook budget is short |
| Codex | bundled MCP server | `SessionEnd` | Root-thread close/archive/delete or Codex's idle unload |
| Kimi Code | bundled MCP server | `SessionEnd` | `exit` and `archive`; `SIGHUP` emergency exit can bypass cleanup |
| OpenCode | native plugin tools | plugin `dispose` and `session.deleted` | Instance unload and permanent session deletion, not a logical session-close event |
| dsh | native `ctx.tools` tools | workspace archive or per-agent `ctx.effect` disposer | Web archive and Agent teardown; whole-process teardown has a five-second grace |

Every adapter hands claimed work to a detached worker immediately because host shutdown budgets are not long-command runtimes. `SIGKILL`, power loss, host bugs, and forceful process-tree termination can still prevent execution.

## Install

### Claude Code

```bash
claude plugin marketplace add CNSeniorious000/agent-atexit
claude plugin install atexit@agent-atexit --scope user
```

For local development:

```bash
claude --plugin-dir ./plugins/atexit
```

### Codex

```bash
codex plugin marketplace add CNSeniorious000/agent-atexit --ref main
codex plugin add atexit@agent-atexit
```

Review and trust the bundled hooks with `/hooks`; Codex intentionally does not trust changed plugin hooks automatically.

### Kimi Code

Inside Kimi Code, install the release ZIP and reload:

```text
/plugins install https://github.com/CNSeniorious000/agent-atexit/releases/download/v0.1.0/agent-atexit-kimi.zip
/reload
```

Kimi installs plugins per user. The adapter stores state under `$KIMI_CODE_HOME/atexit/` because Kimi does not provide a plugin-specific writable data directory, and binds registrations to the current session through `PostToolUse`.

### OpenCode

The npm package is built but will not be published before explicit registry authorization. From a checkout:

```bash
opencode plugin ./adapters/opencode -g
```

After registry publication, the stable form will be `opencode plugin @agent-atexit/opencode@0.1.0 -g`. Registration is immediate by default; set `AGENT_ATEXIT_ASK=1` to ask through OpenCode's permission system before each registration.

### dsh

Build the tarball, then install it separately into every desired profile:

```bash
bun run pack:npm
dsh plugin --profile web add ./artifacts/agent-atexit-dsh-0.1.0.tgz
```

After registry publication, the stable form will be `dsh plugin --profile web add @agent-atexit/dsh`. Restart the profile after add, update, or remove.

Registration is immediate by default. To require approval for every `atexit_register`, add this override to the profile's `cordis.patch.yml`:

```yaml
- id: atexit
  config:
    ask: true
```

## Development

Requires Bun 1.4+ and Node.js 18+:

```bash
bun install
bun run check
bun run artifacts
```

`bun run check` type-checks, builds every runtime, validates manifests, and runs the focused suite. `bun run artifacts` creates the Kimi ZIP plus prebuilt OpenCode and dsh tarballs without publishing them.

Run `bun run watch` to rebuild every host adapter on source changes. It does not serve a host; launch the desired coding agent separately. Linked hosts can reload their rebuilt plugin according to their own lifecycle; dsh profiles whose server HMR watches `adapters/dsh/dist` reload automatically. Start new dsh sessions after a reload because in-memory session bindings are not migrated between plugin instances.

See [docs/lifecycle.md](docs/lifecycle.md) for the state machine and exact host limitations, and [SECURITY.md](SECURITY.md) before enabling the plugin.

## License

MIT
