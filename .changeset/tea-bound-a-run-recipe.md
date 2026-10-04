---
"@demlik/tea": patch
---

`DefineAgentConfig`'s TSDoc now says, per guard, what `maxTurns`, `deadlineMs`,
`maxElapsedMs` and `stopWhen` count and where each one's failure lands, and
what `compaction`'s triggers do. The generated reference pages print each
member's TSDoc above it. `docs/how-to/bound-a-run.md` is now numbered steps, and
the reasoning it carried moved to `docs/explanation/what-bounds-a-run.md`.
