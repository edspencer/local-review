---
"local-review": patch
---

A git call that never finishes no longer hangs the server. Each one now times out after 60 seconds, so a git process stuck in the system (seen with endpoint-security agents on macOS) costs one failed read and the next poll recovers, instead of every project page hanging until restart.
