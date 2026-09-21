# @agent-atexit/opencode

OpenCode adapter for [agent-atexit](https://github.com/CNSeniorious000/agent-atexit). It exposes native register, list, and cancel tools and drains the deferred command stack when the OpenCode plugin instance is disposed.

Use `npm: "@ai-sdk/openai"` for GPT reasoning models on a Responses-capable endpoint so OpenCode can carry reasoning payloads across tool calls. In our OpenCode 1.18.31 checks, the Chat-compatible path dropped the gateway's `reasoning_items` extension.

For automatically generated reasoning variants on custom models, set `reasoning: true` in the model entry. In OpenCode 1.18.31, `--variant high` alone sent no effort setting for an undeclared custom Opus model; declaring the capability made its task requests send adaptive thinking with high effort. This configures the request and does not guarantee cleanup behavior.

For vendor options on a LiteLLM `custom_openai` route, use model `options.extra_body` (for example, `{ "thinking": { "type": "enabled", "clear_thinking": false } }` for a GLM backend that documents this option). In our LiteLLM 1.99.0/OpenAI 2.54.0 checks, top-level `thinking` was dropped with `drop_params`, while `allowed_openai_params` alone failed in the SDK before an HTTP request was sent. Verify the forwarded payload; accepted options do not guarantee backend support or cleanup behavior.

For file-based `@ai-sdk/google` overrides, use `google` as the provider ID. In OpenCode 1.18.31 with SDK 3.0.73, an arbitrary ID such as `eval` can silently drop `thinkingConfig` before sending the request.

The adapter repeats its cleanup guidance beside each assistant message's last finished non-planning tool result, including historical results. Keeping those request prefixes stable supports content-based session matching. Each eligible message retains one 95-word reminder; stored history stays unchanged. This does not guarantee provider affinity or signature preservation.

See the repository README for installation, security, and lifecycle limitations.

## Optional host retry fix

OpenCode 1.18.31 can retry the original model input after a stream failure even when tools have already run. The retry omits those results and can cause duplicate acquisition; adapter guidance cannot supply a result the host has not sent.

[`retry-after-tools.patch`](./retry-after-tools.patch) targets `anomalyco/opencode` tag `v1.18.31` (`014614d35b397775e5d397a490fc72368c894ec2`). After a tool call, retryable stream failures return to the prompt loop, which rebuilds history with completed results, tool errors, or interrupted states. Failures before tool calls retain the existing retry policy; fatal errors, user interruption, and context overflow retain their existing handling. Apply it only to a matching source checkout, then build or run that checkout; installing this adapter does not patch OpenCode.

```sh
git apply --check /absolute/path/to/retry-after-tools.patch
git apply /absolute/path/to/retry-after-tools.patch
cd packages/opencode
bun test --timeout 30000 test/session/processor-effect.test.ts test/session/retry.test.ts test/session/message-v2.test.ts
bun typecheck
```

With Bun 1.4.0, five HTTP regression cases cover completed, failed, and running tools, fatal errors, and context overflow. In a native CLI fault-injection comparison, the original source executed the acquisition twice after losing the stream; the patch executed it once and included the first result in the next request. This prevents blind replay of stale input, not arbitrary tool reexecution. The existing 250 ms cleanup grace can still leave interrupted tools with an unknown outcome; it does not prove that their side effects were undone.
