---
"local-review": patch
---

The branch poll is now nearly free. It used to run two git processes per repo range every 2 seconds, tens of thousands an hour with a dozen ranges, which an endpoint-security agent checking every program launch turns into constant CPU use. It now checks the files git keeps refs in and runs git only when a ref may have moved (an editor's background fetch that moves nothing doesn't count), plus once every 10 minutes as a safety net. It also shares each repo's branch list between its ranges, and doesn't run at all while no browser has a page open.
