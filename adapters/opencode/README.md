# @agent-atexit/opencode

OpenCode adapter for [agent-atexit](https://github.com/CNSeniorious000/agent-atexit). It exposes native register, list, and cancel tools and drains the deferred command stack when the OpenCode plugin instance is disposed.

Use `npm: "@ai-sdk/openai"` for GPT reasoning models on a Responses-capable endpoint so OpenCode can carry reasoning payloads across tool calls. In our OpenCode 1.18.31 checks, the Chat-compatible path dropped the gateway's `reasoning_items` extension.

See the repository README for installation, security, and lifecycle limitations.
