---
"@ai-hero/sandcastle": patch
---

Make chownInContainer non-fatal so sandbox startup doesn't crash when chown -R fails on macOS VirtioFS read-only bind mounts
