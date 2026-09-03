---
name: defer-cleanup
description: Prevent resource leaks when a task creates a CLI-managed session or long-lived process that could survive the current agent session. Use whenever such a resource will remain running for follow-up work.
---

# Deferred cleanup

Before creating the resource, choose a stable cleanup target and register the exact argv that terminates only that resource with `atexit_register`. Make cleanup safe when the resource does not exist yet. If creation assigns the cleanup target, register immediately after receiving it and before continuing the task. Registration is deferred and does not stop the resource during this session; keep it registered while the resource remains available for follow-up so session exit can clean it up.

If creation fails or you clean up the resource normally, cancel the registration. Prefer direct argv over a shell wrapper, and never broaden cleanup to unrelated resources.
