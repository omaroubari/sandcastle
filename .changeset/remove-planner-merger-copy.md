---
"@ai-hero/sandcastle": patch
---

Remove unnecessary `copyToWorkspace` and `branchStrategy` from planner and merger agents in parallel planner templates. These lightweight agents (maxIterations: 1) now default to head mode, avoiding the overhead of copying node_modules into worktrees.
