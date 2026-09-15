---
name: defer-cleanup
description: Prevent resource leaks when a task creates a CLI-managed session or long-lived process that could survive the current agent session. Use whenever such a resource will remain running for follow-up work.
---

# Deferred cleanup

Use `atexit_register` as a fallback for temporary processes and CLI-managed sessions, including browser TaskSpaces, that remain live between tool calls. Register runnable cleanup for a known target, never a placeholder or guessed handle. If creation assigns the target, create first, then register in the first response after receiving it. When the target is already known and cleanup tolerates its absence, registration can accompany independent setup work. Keep the fallback while the resource remains available for follow-up.

Use parallel tool calls to include ready registry updates with independent work in the same response, including work on other resources. Avoid a registry-only response when such work is ready, without delaying registration to find a batch partner.

After successful normal cleanup or confirmation that creation left no resource, cancel its registration. Cancellation removes the fallback without executing it. Never cancel in parallel with the cleanup it protects, since failure would leave no fallback. If programmable orchestration is available, await and check cleanup success, then cancel in the same invocation. When no useful independent work remains, a separate round is appropriate; do not invent work or split efficient cleanup just to fill a batch.

Prefer direct argv over a shell wrapper, and never broaden cleanup to unrelated resources.
