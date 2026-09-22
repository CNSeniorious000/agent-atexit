# Hermes

Merge `config.yaml` into your Hermes configuration, replacing `/absolute/path/to/agent-atexit` with this checkout. Build the portable plugin first with `bun run build`, and copy `plugins/atexit/skills/defer-cleanup` into `$HERMES_HOME/skills/`. Export `HERMES_HOME` (normally `~/.hermes`), or replace its references in the config with an absolute path. Hermes filters inherited MCP environment variables, so configure the same state directory explicitly for both MCP and hooks.

Use Hermes 0.21.4 or newer. The template sets `skills.auto_load: [defer-cleanup]`, so `hermes chat` loads the installed skill into each new session without an extra CLI flag or a system-prompt patch. Merge this entry with any existing auto-loaded skills. Missing or disabled skills are skipped, and `--ignore-rules` / `HERMES_IGNORE_RULES=1` suppresses auto-loading. Changes take effect in a new session. Older releases can explicitly preload the skill with `hermes chat -s defer-cleanup`.

Skill loading and MCP tool visibility are separate. Hermes 0.21.4 still defers MCP tool descriptions and ignores `anthropic/alwaysLoad`; the compatibility setup below exposes atexit tools from the first request.

Hermes passes registration results to `post_tool_call`; `on_session_finalize` drains the same session. Do not use `on_session_end`: it fires after each turn while resources may still be needed.

`plugins.hook_callback_timeout: 0` makes plugin callbacks run on their caller threads. Hermes 0.21.3 otherwise skips overlapping invocations of the same callback, which can lose a registration's session binding during parallel tool calls. This setting affects all plugin callbacks; the shell hooks above still enforce their own three-second command timeout.

Verified entry point: `hermes chat --oneshot --query-file prompt.txt --accept-hooks`. Hermes 0.21.3's separate top-level `hermes -z PROMPT` path does not emit `on_session_finalize`, so deferred cleanup is not supported on that path.

Use a fresh session ID after finalization. Resuming a finalized session ID is unsupported: its closed state causes newly bound cleanup to execute immediately. Hermes's `on_session_start` is tied to prompt construction and can be skipped when restoring a cached prompt, so adding that hook alone does not provide a reliable reopen boundary.

## MCP tool visibility

[always-load.patch](always-load.patch) adds support for the Claude-compatible per-tool `_meta["anthropic/alwaysLoad"]: true` extension. It changes four Hermes runtime files (22 insertions, 7 deletions) and includes two contract tests. Only a strict `true` makes an available MCP tool direct; explicit `tools.tool_search.defer` overrides it. Profile scope, include/exclude filters, permissions, and the original array-based tool-call wrapper remain unchanged. Other metadata never enters model schemas. Legacy schema-cache entries refresh individually on their next lookup; there is no full-cache clear.

The patch applies to pristine Hermes commit `d337b736aa1e8ebecfab043842d13e4a2d2f48a3` (0.21.4), with both included contracts passing. Earlier baseline and candidate comparisons used commit `5d59366010640c1d6b8f170d8a4ee109db2bbdef` (0.21.3). Point `hermes_checkout` at the checkout used by your `hermes` command. Check applicability before applying; if it fails, inspect version differences rather than forcing the patch. Installation and configuration do not apply it automatically.

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

Adapter-local validation recorded both contracts failing on control and passing on candidate; the existing focused suite passed 322 tests with one host skip. They cover live/cache metadata equivalence, selective legacy refresh, strict booleans, metadata isolation, explicit deferral, profile scope, and registry generation.

In the earlier four-task comparison of the visibility patch alone with Claude Opus 5, control freeform/CLI scored **4/6 and 4/6**, while candidate scored **5/6 and 6/6**. The six checks cover provenance, timely registration, useful batching, safe cancellation, actual resource lifecycle, and session-bound cancellation. Candidate freeform still omitted the final beta cancellation. Initial requests exposed all three atexit tools, adding 2,591 schema characters. The native executor ran these batches sequentially; the evidence concerns same-response batching. These samples do not establish reliable batching or cancellation across tasks, or validate the native auto-load setup above.

## Guidance delivery

The shared skill and tool descriptions provide the cleanup rules. Hermes 0.21.4's native [`skills.auto_load`](https://github.com/NousResearch/hermes-agent/blob/d337b736aa1e8ebecfab043842d13e4a2d2f48a3/website/docs/user-guide/configuration.md#L793-L802) supplies the complete skill through Hermes's own prompt lifecycle. Guidance delivery no longer requires the optional `mcp-instructions.patch`, private MCP registries or a patched prompt layout.

The MCP command still selects `--hermes` metadata for compatibility, but Hermes 0.21.4 does not pass `initialize.instructions` to the model. Those server instructions are not the delivery path for this setup. Earlier native results used the removed carrier.

Fresh 0.21.4 runs using this configuration exercised Opus 5 and GPTAstra on both the original freeform and immutable-CLI tasks, once per condition. All four received the complete skill in their first request, registered both services promptly, waited for release proof before cancellation, completed the staged lifecycle and closed their actual sessions with every registration cancelled. All eight service processes and ports were released without evaluator cleanup. Three tasks passed all six criteria; Opus freeform spent a separate final cancellation turn before removing its temporary directory, missing an available batching opportunity. These observations validate native guidance delivery, not reliable batching or a causal improvement over the previous carrier.

## MCP tool name repair (optional)

When a model emits `atexit_register` or `atexit__atexit_register` instead of the exposed `mcp__atexit__atexit_register`, Hermes 0.21.4 rejects the call before its existing argument coercion and hooks. [mcp-name-repair.patch](mcp-name-repair.patch) resolves exact short names or restores a missing `mcp__` prefix only when the combined candidates have one owner among tools enabled for the profile and exposed to the session. Normalized canonical names must also be unique. Unknown namespaces and ambiguous names are not guessed; canonical dispatch, trust checks, argument coercion and hooks remain in place. Catalog inspection does not overwrite another session's legacy tool selection. If that lookup fails, inferred MCP names are rejected while unrelated builtin name repair continues.

This optional patch changes two runtime files and adds 61 contract cases. It applies to pristine Hermes 0.21.4 commit `d337b736aa1e8ebecfab043842d13e4a2d2f48a3`; all 61 cases pass with the fixture adapted to the current logging method. Its files do not overlap the other patches. Earlier native replay evidence below used 0.21.3. Use the MCP visibility setup above; the included tests and native replay require `always-load.patch`. Installation does not apply this patch automatically. Check applicability before applying:

```sh
atexit_checkout=/absolute/path/to/agent-atexit
hermes_checkout=/absolute/path/to/hermes-agent
patch_file="$atexit_checkout/adapters/hermes/mcp-name-repair.patch"
git -C "$hermes_checkout" apply --check "$patch_file"
git -C "$hermes_checkout" apply "$patch_file"
git -C "$hermes_checkout" apply --reverse --check "$patch_file"
(cd "$hermes_checkout" && bash scripts/run_tests.sh -j 1 tests/agent/test_mcp_name_repair.py -q --tb=short --file-retries 0)
```

To revert, run `git -C "$hermes_checkout" apply --reverse --check "$patch_file"`, then `git -C "$hermes_checkout" apply --reverse "$patch_file"`.

Validation covers all 61 contract cases and eight existing name-repair regressions, exact application/reversal and repeat-apply rejection. In a deterministic native CLI replay against a local scripted provider, the previous runtime rejects both names missing the `mcp__` prefix; the patched runtime uses real MCP calls and shipped hooks to bind and cancel both records in the actual session. Both sessions close and all four service processes and ports are released without evaluator rescue. This replay tests the host, not model decisions.

Original model tasks still omitted registration with the earlier short-name repair, including a trial with a different skill summary. A later instruction-carrier trial exposed the missing-prefix error and premature cancellation. The summary is not shipped. Those instruction-carrier trials are historical; the prefix repair has deterministic dispatch evidence only. The name repair does not establish reliable triggering, timely registration or batching, and those failed observations remain in the evaluation record.

## One-shot review shutdown (optional)

Quiet one-shot runs can exit while an automatic Anthropic Messages or Chat Completions review still owns its HTTP request. [background-review-shutdown.patch](background-review-shutdown.patch) coordinates review cancellation before session finalization. It tracks streaming and nonstreaming request workers, waits for them and the cancellation thread to exit, then releases the review's SDK clients. All shutdown waits share the existing two-second budget.

This separate patch (seven runtime files and one test file) applies to pristine Hermes 0.21.4 commit `d337b736aa1e8ebecfab043842d13e4a2d2f48a3`. The port preserves the earlier behavior while following the CLI helper file split and new initialization context. It is independent of the MCP visibility patch and is not applied by installation. Its ownership checks target automatic Anthropic Messages and standard Chat Completions reviews in the quiet one-shot path. OpenAI request clients are tracked at their factory so borrowed primary clients are never treated as privately owned. Interactive sessions, explicit reviews, MoA and other provider paths retain their existing cleanup behavior.

```sh
atexit_checkout=/absolute/path/to/agent-atexit
hermes_checkout=/absolute/path/to/hermes-agent
patch_file="$atexit_checkout/adapters/hermes/background-review-shutdown.patch"
git -C "$hermes_checkout" apply --check "$patch_file"
git -C "$hermes_checkout" apply "$patch_file"
git -C "$hermes_checkout" apply --reverse --check "$patch_file"
```

To revert, check the reverse patch before applying it:

```sh
git -C "$hermes_checkout" apply --reverse --check "$patch_file"
git -C "$hermes_checkout" apply --reverse "$patch_file"
```

The patch SHA-256 is `68e8b3e7c09ae4e5e64fc083fb285af996513d9256f9749dc9f9798498e177af`. Applying and reversing it reproduces the exact candidate and original source bytes with LF checkout settings, including removal of the added test; repeat application is rejected. Run its ownership contracts through Hermes' normal test runner:

```sh
(cd "$hermes_checkout" && bash scripts/run_tests.sh -j 1 tests/agent/test_review_client_ownership.py -q --tb=short --file-retries 0)
```

A real SDK against a local HTTP server verifies Chat streaming completion, cancellation while waiting for response headers, partial SSE cancellation and partial JSON cancellation, plus the three existing Anthropic lifecycle cases. All seven release the private SDK and request owner before session finalization on 0.21.4; 21 ownership contracts and 15 existing upstream regressions also pass. In the earlier 0.21.3 comparison, the Anthropic-only patch left the three cancelled Chat requests alive at that point and needed test cleanup. The invariant tests also cover borrowed clients, cancellation during acquisition, cached clients, failed closure, retained unknown clients and the shared shutdown deadline.

If an owner or client cannot finish cleanup within the bound, shutdown reports failure and keeps its ownership record. Later automatic reviews may remain blocked; eventual cleanup is not guaranteed. Cancelling an unfinished generation does not make that generation complete. These lifecycle checks do not establish improved atexit triggering, batching or model completion.
