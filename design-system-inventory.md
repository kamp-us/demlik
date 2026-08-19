# Design-system inventory — demlik

**What this is.** The primitives that already exist, so construction *selects* one instead of
hand-building a fifth variant of it. If a surface needs something not on this list, that is a gap to
name in the PR's `## Deviations`, not a component to invent quietly.

demlik ships no component library and no CSS framework. The system is one hand-written stylesheet —
`demo/lane-view/style.css`, 378 lines — read by one React entry point, `demo/lane-view/main.tsx`.
The primitives are therefore **class names**, not imports. Reach for them by role.

## The shell

| Primitive | Class | What it is |
| --- | --- | --- |
| Console shell | `.op` | The three-region fixed grid: `hd` across the top, `rail` and `stage` below. `100dvh`, never scrolls. Every full-page surface starts here. |
| Strip | `.hd` | The top band. Chrome-coloured, one border below. Holds the verdict, the counts and the source. |
| Rail | `.rail` | The fleet list. Chrome-coloured, own scroll, becomes a capped strip above the stage under 60rem. |
| Stage | `.stage` | The detail pane. Canvas-coloured, own scroll, generous bottom padding so the last row clears the fold. |

## Strip primitives

| Primitive | Class | Notes |
| --- | --- | --- |
| Brand | `.hd-brand` | Muted, weight 600. Identity, not a heading. |
| Verdict | `.hd-say` | The rollup in a sentence — the one thing readable across a room. Variants `.is-needs-you`, `.is-tripped`. **`.is-unreadable` is emitted by `main.tsx` and has no rule.** |
| Count chip | `.hd-chip` | Pill, bordered, muted label with a `<b>` value in tabular figures. Variants `.is-needs-you`, `.is-tripped` recolour both border and text. |
| Source | `.hd-src` | Mono, muted, right-aligned, `direction: rtl` so a long path truncates at the *front* and the leaf stays readable. |
| Heartbeat | `.hd-live` | 6px dot, green, pulsing. `aria-hidden`, and stilled under reduced motion. |

## Rail primitives

| Primitive | Class | Notes |
| --- | --- | --- |
| Lane row | `.rail-row` | A full-width `<button>` in a `<li>`. 3px left border carries attention state; `.on` marks the open lane. Attention variants: `.is-needs-you`, `.is-tripped`, `.is-quiet`, `.is-moving`, `.is-done`, `.is-unstarted`. **No `.is-unreadable`.** |
| Lane id | `.rail-id` | Weight 600, tabular figures. |
| Driver chip | `.rail-drv` | Mono pill in `ref` blue. Present only when a claim was actually read — absent means unknown, never unclaimed. |
| Headline | `.rail-head` | Secondary text, 0.8rem, tight leading. |
| Meta | `.rail-meta` | Muted, tabular. Progress and quiet-age, joined with ` · `. |

## Stage primitives

| Primitive | Class | Notes |
| --- | --- | --- |
| Stage header | `.stage-hd` + `h1` + `.stage-sub` | Baseline-aligned, wraps. The `h1` is tabular because it is usually an id. |
| Action card | `.act` | Raised, bordered, 8px radius. The one card shape in the system. |
| Card heading | `.act-h` | 0.78rem, uppercase, wide tracking. `.act-sub` inside it drops back to sentence case, muted, italic. |
| Action row | `.act-row` | Three-column grid, separated by `border-subtle` tops, collapsing to one column under 48rem. |
| Task name | `.act-task` | Mono, wraps anywhere — these are machine-authored and can be long. |
| Event button | `.act-btn` | Mono, control-coloured, teal on hover, 45% opacity when disabled. The only button in the system. |
| Result | `.act-said` | `.ok` green, `.no` amber. |
| Empty state | `.lv-empty` | Centred, max 46rem, with a `<pre>` block for the command to run. |
| Diagram | `.stage .tea-lv-mermaid svg` | Full width, capped at `min(100%, 46rem)`. Undrawn diagrams are `visibility: hidden`, holding their height so a redraw does not collapse the page. |

## What does not exist yet

No form control beyond the event button. No table. No modal, popover, tooltip or toast. No icon set —
the system currently carries exactly one non-text mark, the heartbeat dot. No focus-visible rule
anywhere in the stylesheet, so every interactive element falls back to the UA default ring.

Each of those is a genuine gap, not an omission for tidiness. Building one is a decision to take
deliberately, against the manifest's pillars, and to record.
