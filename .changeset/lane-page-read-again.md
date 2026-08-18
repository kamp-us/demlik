---
"@demlik/tea": patch
---

**`@demlik/tea/chart/lane/react` (experimental)** — the lane page, read again by a person and fixed where it lied.

Every item below was found by rendering a real lane in a browser and reading it, not by an assertion. Each now has one that fails without its fix.

**A live lane no longer dispatches into the present while you are looking at the past.** The scrubber moves the view; the runtime stays where it is. So while the cursor was behind the tape, every control was still enabled, computed its outcome (`→ build`) from the state ON SCREEN, and dispatched into the state that was actually there — a click both mis-stated what it would do and gave no sign it had done it (the only feedback anywhere was `step 3 of 6` becoming `step 3 of 7`). Scrubbing now turns the controls off and says why, through the same "unavailable, with the reason" machinery a replay source has always used.

**A lane that finished successfully draws its diagrams again.** Only an `active` or `tripped` phase expanded anything, so a lane that ended the way lanes are meant to end rendered zero diagrams — under its own paragraph promising one under every task. The phase a lane ENDED in now expands, by the same rule the active one uses.

**Why nothing can be dispatched is a fact of the source, and is stated as one.** The sentence used to be scraped back off the first non-refused control; on a finished lane the chart refuses every control, so the page dropped its one explanation exactly where six dead buttons needed it. `LaneViewModel` now carries `noDispatch` and the feed declares it.

**A refused message is drawn as a step, not as a walk.** A total chart answers everything, so a message nothing routes still lands and still gets a row — rendered `issue_1 DONE review → review` it was indistinguishable from a self-loop the chart declares. `LaneStepView.refused` marks it and the row says "refused, nothing moved".

**The picture carries polarity.** An error final and a success final were both lit the same blue at the moment one of them was where a task died, while every other surface (chip, badge, stuck panel) said so in red. `stateDiagram-v2` has no per-edge styling, so the lit node wears a class of its own.

**`"DONE" is not addressed to phase "working" (scope: edges)` is gone.** `scope: "edges"` means the event is live exactly where an edge declares it — it is not a phase name, so the phase test could never pass and the refusal named a phase that had nothing to do with it. `RefusalReason` gains a `no-edge` kind and the sentence is now `"queued" declares no "DONE" edge`. Since `edges` is the default scope, this was most refusals on most charts, and it was the densest jargon on a page that otherwise works hard to teach.

**Sentences that were wrong when they were said.** A tripped lane is no longer badged `DONE` (that was `deriveLaneStatus`'s internal `done | active` printed raw, one span from the word `tripped`); "N tasks running together" is now the standing's own count, and never says "1 task running together"; a single-phase lane no longer opens "A lane is 1 phase that run in order"; a collapsed task reads "still at `review`" rather than "not started" beside a chip saying `= review`; and a task on an error final speaks of the trip in the tense it happened in.

**The page reads with no stylesheet at all.** Separators between adjacent inline spans are in the markup, so a bare host gets `5674 · replay · tripped · stopped here` rather than `5674replaytrippeddone`. The stylesheet only makes them quiet.

**A collapsed diagram is not rendered until it is opened.** All twelve `<pre class="mermaid">` of a twelve-task lane were in the DOM and every mermaid host rendered all twelve; keyed by their own text, one step of the scrubber remounted and re-rendered the lot. The fold now costs what it looks like it costs.

**`chart/lane/styles.css` is one stylesheet again.** It had been written in two passes, the second re-declaring `.tea-lv`, `.tea-lv-head`, `.tea-lv-panel`, `.tea-lv-stuck`, `.tea-lv-mermaid` and `.tea-lv-steps` wholesale with `.tea-lv-btn` appearing five times — half the first pass was dead by cascade. One authoritative declaration per selector, theme-token fallbacks intact. The cascade had also inverted the page's affordances: the two clickable events rendered as plain text while the four disabled ones kept a dotted box. A button now looks like a button while it can be pressed.
