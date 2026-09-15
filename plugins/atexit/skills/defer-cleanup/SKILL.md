---
name: defer-cleanup
description: Prevent resource leaks when a task creates a CLI-managed session or long-lived process that could survive the current agent session. Use whenever such a resource will remain running for follow-up work.
---

# Deferred cleanup

Register scoped, runnable fallback cleanup with `atexit_register` for temporary processes and CLI sessions kept live between tool calls. Cover all newly acquired resources in the first response after their real cleanup targets are known. Registration may accompany creation when the target is already known and cleanup tolerates absence. Prefer direct argv; keep the fallback until normal cleanup succeeds.

Avoid spending a model turn only on registry bookkeeping when independent task work is ready. Use parallel calls or one orchestration invocation: registration can accompany resource use or inspection. After normal cleanup succeeds, cancel its fallback alongside independent work, including cleanup of other resources. Cancellation removes the fallback without running it. Wait for the successful cleanup result before cancelling; never put both in the same parallel batch. Within an orchestration invocation, await cleanup and check success before cancelling. A standalone call is appropriate when nothing independent remains; do not invent work or delay registration to fill a batch.
