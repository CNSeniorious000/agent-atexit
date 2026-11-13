# Compatibility testing

## CI coverage

The [CI workflow](../.github/workflows/ci.yml) separates portable runtime checks from native adapter SDK compatibility. DSH is one adapter, not a prerequisite for the portable MCP plugin.

| Checks | Coverage |
| --- | --- |
| `Checks` | Type-check, build, manifests and the complete test suite on Linux, macOS and Windows with Node 26; Linux also checks the declared Node 18 floor. Bun runs the source tests; Node runs the portable MCP and hook subprocesses. |
| `Adapter SDK` | DSH 0.1.1-rc.2, 0.2.1-rc.2, 0.2.2-rc.1 and 0.2.2-rc.2; OpenCode v1 SDK 1.18.27 and v2 SDK 2.1.4. Each row replaces the selected SDKs, type-checks and runs that adapter's fixtures. DSH's coordinated transitive package versions are pinned and checked too. |
| Locked dependencies | The normal checks cover the current versions in `bun.lock`; compatibility rows retain older supported APIs. Each OpenCode row changes one generation's SDK and runs the shared adapter suite. |
| Artifacts | Every OS verifies that rebuilding the portable bundles leaves no diff. Linux/Node 26 also packs, verifies and uploads the Kimi ZIP and npm tarballs. |

Claude, Codex, Kimi and Hermes share the portable MCP/hook implementation. Their payload contracts are exercised in `packages/mcp/test/`, including flat and wrapped Hermes results, session isolation, finalization and resume. These tests do not launch those agents or prove that a host emits the expected events.

CI runs on pull requests and pushes to `main`, avoiding duplicate branch-push runs. Test jobs use read-only repository permissions, explicit runtimes, bounded timeouts and independent matrix failures. Build/setup actions are pinned to commit SHAs with version comments for Renovate. The separately maintained review workflow intentionally tracks `promplate/code-review@main`.

## Native smoke results

Manual checks on macOS, 2026-11-14, using this branch's built adapters and real model/tool calls:

| Host | Version | Verified lifecycle |
| --- | --- | --- |
| Claude Code | 2.1.323 | Bundled MCP registration, binding and normal CLI exit |
| Codex | 0.169.0 | Cached plugin installation, MCP registration and `codex exec` exit |
| Kimi Code | 2.6.2 | TUI registration and `/exit`; resume the same session ID, register again, then `/exit` |
| OpenCode v1 | 1.19.5 | Native registration and `POST /instance/dispose` |
| OpenCode v2 | 2.3.0 | Native registration and permanent session deletion |
| DSH | 0.2.2-rc.1 | Headless native registration and Agent teardown |
| Hermes | 0.23.1, clean upstream release | Native MCP registration and interactive `hermes chat --cli` → `/quit` |

For each passing path, the temporary file existed while the registration was `pending`, then disappeared with a `succeeded` record and exit code 0 after the native lifecycle event. These are explicitly requested cleanup probes; they do not measure whether a model independently recognizes every resource that needs a fallback.

Two observed limitations are outside the passing paths:

- Kimi 2.6.2 `-p` discovered the plugin's MCP tools but omitted them from the model's request schema. Both normal and non-dynamic model capability settings reproduced it; TUI calls worked. Do not count MCP connection alone as a successful smoke test.
- Hermes 0.23.1 `chat --oneshot --cli` bound the registration but left it `pending` after the CLI exited and after stopping its isolated gateway. Interactive `/quit` finalized correctly. The adapter cannot infer a safe session end when the host omits `on_session_finalize`; do not use the one-shot result as an exit-cleanup guarantee.

## Repeating a native check

1. Run `bun install --frozen-lockfile && bun run check`, then install the built adapter using the host's documented native mechanism. Use a temporary host profile/workspace; Codex needs a fresh cached plugin copy. Configure model access locally, without committing credentials or exporting authenticated logs.
2. Create a uniquely named temporary file. Ask the real agent to register an exact `node -e`/`fs.unlinkSync` command for that file and list the returned ID. Require `pending` and verify the file still exists. A `provisional` result means the binding hook has not completed or did not run.
3. Trigger the supported lifecycle from the table. Inspect that exact record for `succeeded` and exit code 0, and independently verify the file is absent. An assistant's final answer is not evidence of cleanup. For resume support, repeat with the same session ID and a new file; the second registration must stay pending until the second exit.
4. Stop temporary servers, remove temporary credentials/plugin installations, and remove the isolated profile. If a probe failed, release its exact resource and cancel its registration before removing the state directory.

Native model-backed checks are manual because they need host installations, authentication and trusted hooks. Add a captured payload regression when a smoke test reveals a contract change, then rerun the real host to validate the fix.
