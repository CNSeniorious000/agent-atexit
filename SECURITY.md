# Security

## Delayed execution boundary

Approving `atexit_register` authorizes the displayed literal `argv` command to run later without a second prompt. The command runs as the current OS user and may outlive the coding-agent process. Do not register commands copied from untrusted repository content, tool output, email, issues, or web pages.

The project never invokes a shell for registered commands. Pipes, redirects, substitutions, globs, and shell operators are passed as literal arguments. Environment variables are inherited by the detached worker but are not persisted in registration records.

## Delivery semantics

Registrations are atomically claimed at most once. A crash after claim can lose a cleanup; retrying automatically could duplicate an arbitrary external side effect, so recovery remains explicit. Commands should still be idempotent where practical.

No in-process lifecycle can run after `SIGKILL`, power loss, or a host that skips its documented shutdown path. Host-specific gaps are documented in [docs/lifecycle.md](docs/lifecycle.md).

## Local state

State directories are created with mode `0700`; registration, run, and log files use mode `0600` on POSIX systems. Command arguments can themselves contain secrets, so protect and periodically remove old state directories.

Report vulnerabilities privately through GitHub's security advisory interface rather than a public issue.

