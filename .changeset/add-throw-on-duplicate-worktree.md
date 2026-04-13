---
"@ai-hero/sandcastle": patch
---

Add `throwOnDuplicateWorktree` option to `RunOptions` and `CreateSandboxOptions`. When set to `false`, a worktree collision reuses the existing worktree instead of failing. Defaults to `true` (current behavior).
