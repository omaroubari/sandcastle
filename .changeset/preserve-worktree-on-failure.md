---
"@ai-hero/sandcastle": patch
---

Preserve worktree on failure (timeout, agent error, SIGINT, SIGTERM)

When a run session ends in failure, the sandbox (Docker container) is removed but the
worktree is now preserved on the host. A message is printed with the worktree path and
manual cleanup instructions. On successful completion, both the sandbox and worktree
are removed as before.

`TimeoutError` and `AgentError` now carry an optional `preservedWorktreePath` field
so programmatic callers can inspect or build on the preserved worktree.
