---
"@demlik/tea": minor
---

The lane viewer is an operator console rather than a document.

The page was two screens — a fleet list, and a lane you reached by leaving the
list — capped at a column in the middle of the window. Opening a lane hid the
fleet, which defeats the point: the reason to look up from one lane is another
lane going amber.

It is now one full-width screen. A strip carries the verdict as a sentence
(`1 lane tripped`) with the counts and a live indicator; a rail holds every
lane permanently, sorted by which needs a person; the stage takes the rest.
The page itself no longer scrolls — rail and stage scroll independently, so
reading a twelve-task epic cannot push an amber lane off screen. It opens on
the rail's first row, which is already the answer to "what should I look at".

A lane whose `workflow.json` will not parse no longer takes the screen with
it. Charts were compiled inside render, so one malformed file threw during
commit and blanked every healthy lane beside it. The parse now happens once
per lane and its failure is a value: the lane keeps its row, carrying the
parser's own complaint, and its page says which file broke and how to look at
it. A render error boundary catches whatever the parse does not.

Diagrams are bounded and hold their place while they redraw, so stepping
through an event log no longer collapses the page under the reader.
