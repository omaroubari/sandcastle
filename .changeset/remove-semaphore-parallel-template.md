---
"@ai-hero/sandcastle": patch
---

Remove semaphore concurrency limiter from parallel-planner-with-review template. Issue pipelines now run concurrently via Promise.allSettled without a concurrency cap, matching the parallel-planner template.
