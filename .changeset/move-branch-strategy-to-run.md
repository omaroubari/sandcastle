---
"@ai-hero/sandcastle": patch
---

Move `branchStrategy` from sandbox provider config to `run()` options. Branch strategy is now specified as an optional field on `RunOptions` instead of on provider factory functions like `docker()`. When omitted, defaults to `{ type: "head" }` for bind-mount providers and `{ type: "merge-to-head" }` for isolated providers. Using `{ type: "head" }` with an isolated provider now throws a clear runtime error.
