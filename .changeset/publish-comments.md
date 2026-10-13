---
"local-review": minor
---

Review threads can be marked **for the GitHub PR**: a **For the GitHub PR** box in the composer for new general and
inline comments, and on every existing thread (Conversation, Files changed and the Comments tab). A marked thread has
a teal **For GitHub** label (**On GitHub ↗**, a link, once the agent has posted it), isn't counted as an open thread
or in review progress, and is left for the agent to post as a GitHub review when it publishes the stack. The Comments
tab gets **All / Open / For GitHub** filters with counts. In the review file it's `publish: true` on the thread, and
the agent records `published: {url, id, at}`; `POST …/threads` takes `publish`, and `PATCH …/threads/:tid` takes
`publish` and `published`. `local-review plan` lists each PR's marked threads with file and line (`publish_threads`
in JSON) and warns about outdated ones and published PRs with comments not posted yet. Local Review still never talks
to GitHub, and reads nothing back from it.
