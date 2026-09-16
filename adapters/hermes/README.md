# Hermes

Merge `config.yaml` into your Hermes configuration, replacing `/absolute/path/to/agent-atexit` with this checkout. Build the portable plugin first with `bun run build`, and copy `plugins/atexit/skills/defer-cleanup` into `$HERMES_HOME/skills/`. Export `HERMES_HOME` (normally `~/.hermes`), or replace its references in the config with an absolute path. Hermes filters inherited MCP environment variables, so configure the same state directory explicitly for both MCP and hooks.

Start sessions with `hermes chat` for normal skill discovery; add `-s defer-cleanup` for explicit preload. The tested Hermes 0.21.3 checkout defers MCP tool descriptions and ignores the server's `anthropic/alwaysLoad` metadata. Apply the compatibility patch below to expose atexit's tools from the first request. This version has no `skills.preload` configuration key.

Hermes passes registration results to `post_tool_call`; `on_session_finalize` drains the same session. Do not use `on_session_end`: it fires after each turn while resources may still be needed.

`plugins.hook_callback_timeout: 0` makes plugin callbacks run on their caller threads. Hermes 0.21.3 otherwise skips overlapping invocations of the same callback, which can lose a registration's session binding during parallel tool calls. This setting affects all plugin callbacks; the shell hooks above still enforce their own three-second command timeout.

Verified entry point: `hermes chat --oneshot --query-file prompt.txt --accept-hooks`. Hermes 0.21.3's separate top-level `hermes -z PROMPT` path does not emit `on_session_finalize`, so deferred cleanup is not supported on that path.

## MCP tool visibility

[always-load.patch](always-load.patch) adds support for the Claude-compatible per-tool `_meta["anthropic/alwaysLoad"]: true` extension. It changes four Hermes runtime files (22 insertions, 7 deletions) and includes two contract tests. Only a strict `true` makes an available MCP tool direct; explicit `tools.tool_search.defer` overrides it. Profile scope, include/exclude filters, permissions, and the original array-based tool-call wrapper remain unchanged. Other metadata never enters model schemas. Legacy schema-cache entries refresh individually on their next lookup; there is no full-cache clear.

The patch applies to pristine Hermes commit `5d59366010640c1d6b8f170d8a4ee109db2bbdef` (0.21.3), verified from read-only Git objects. All four runtime files match the evaluation baseline byte for byte; that evaluation checkout had pre-existing local changes elsewhere. Point `hermes_checkout` at the checkout used by your `hermes` command. Check applicability before applying; if it fails, inspect version differences rather than forcing the patch. Installation and configuration do not apply it automatically.

```sh
atexit_checkout=/absolute/path/to/agent-atexit
hermes_checkout=/absolute/path/to/hermes-agent
patch_file="$atexit_checkout/adapters/hermes/always-load.patch"
git -C "$hermes_checkout" apply --check "$patch_file"
git -C "$hermes_checkout" apply "$patch_file"
git -C "$hermes_checkout" apply --reverse --check "$patch_file"
```

Run the included contracts with Hermes' test environment, then start a new session:

```sh
(cd "$hermes_checkout" && bash scripts/run_tests.sh -j 1 tests/tools/test_mcp_always_load.py -q --tb=short --file-retries 0)
hermes chat
```

To revert, first check that later edits do not conflict:

```sh
git -C "$hermes_checkout" apply --reverse --check "$patch_file"
git -C "$hermes_checkout" apply --reverse "$patch_file"
```

## Validation and limits

The shipped patch is byte-identical to the frozen candidate (SHA-256 `1a1678e304e3ecfae4db0c2f464a6b2d5d028e4bf1e2ad7531b416c8c9161ec9`). Packaging validation applied it to a temporary copy of the four baseline files, checked exact candidate contents including the added test file, and reverted to the original bytes with the test removed. Repeat application is rejected. No installed Hermes files were changed by validation.

The two contracts failed on control and passed on candidate; the existing focused suite passed 322 tests with one host skip. They cover live/cache metadata equivalence, selective legacy refresh, strict booleans, metadata isolation, explicit deferral, profile scope, and registry generation. Claude Opus 5 reviewed the runtime patch and found no actionable correctness issue.

In the four-task native comparison with Claude Opus 5, control freeform/CLI scored **4/6 and 4/6**, while candidate scored **5/6 and 6/6**. The six checks cover provenance, timely registration, useful batching, safe cancellation, actual resource lifecycle, and session-bound cancellation. Candidate freeform still omitted the final beta cancellation. Initial requests exposed all three atexit tools, adding 2,591 schema characters. The native executor ran these batches sequentially; the evidence concerns same-response batching. These samples do not establish reliable batching or cancellation across tasks.
