# @agent-atexit/opencode

OpenCode adapter for [agent-atexit](https://github.com/CNSeniorious000/agent-atexit). It exposes native register, list, and cancel tools and drains the deferred command stack when the OpenCode plugin instance is disposed.

Use `npm: "@ai-sdk/openai"` for GPT reasoning models on a Responses-capable endpoint so OpenCode can carry reasoning payloads across tool calls. In our OpenCode 1.18.31 checks, the Chat-compatible path dropped the gateway's `reasoning_items` extension.

For automatically generated reasoning variants on custom models, set `reasoning: true` in the model entry. In OpenCode 1.18.31, `--variant high` alone sent no effort setting for an undeclared custom Opus model; declaring the capability made its task requests send adaptive thinking with high effort. This configures the request and does not guarantee cleanup behavior.

For vendor options on a LiteLLM `custom_openai` route, use model `options.extra_body` (for example, `{ "thinking": { "type": "enabled", "clear_thinking": false } }` for a GLM backend that documents this option). In our LiteLLM 1.99.0/OpenAI 2.54.0 checks, top-level `thinking` was dropped with `drop_params`, while `allowed_openai_params` alone failed in the SDK before an HTTP request was sent. Verify the forwarded payload; accepted options do not guarantee backend support or cleanup behavior.

For file-based `@ai-sdk/google` overrides, use `google` as the provider ID. In OpenCode 1.18.31 with SDK 3.0.73, an arbitrary ID such as `eval` can silently drop `thinkingConfig` before sending the request.

The adapter repeats its cleanup guidance beside each assistant message's last finished non-planning tool result, including historical results. Keeping those request prefixes stable supports content-based session matching. Each eligible message retains one reminder; stored history stays unchanged. This does not guarantee provider affinity or signature preservation.

Source-based hints point out potentially hidden verification errors and piped stdio in detached launchers. These advisory matches inspect tool arguments, not results: they can miss unsupported syntax or flag unrelated code. They do not prove resource state, block actions, or change tool execution. Models must still establish target-specific release before cancelling cleanup.

See the repository README for installation, security, and lifecycle limitations.

## Host retry behavior

OpenCode 1.18.31 can retry the original model input after a stream failure even when tools have already run. The retry omits those results and can cause duplicate acquisition; adapter guidance cannot supply a result the host has not sent. The host's cleanup grace can also leave interrupted tools with an unknown outcome; do not assume their side effects were undone. The adapter does not change this host behavior. Experiments with local host fixes are separate from validation on an unmodified OpenCode installation.
