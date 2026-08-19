# Design-system manifest — demlik

**What this governs.** Every rendered surface demlik ships. Today that is one surface: the lane
viewer (`demo/lane-view/`, built for hosts by `build-viewer.mjs` into `dist/chart/lane/viewer`).
It is an **operator console**, not a marketing page or a document — a thing a person leaves open on
a second monitor and glances at from across a room. Every rule below is downstream of that.

This file is the law. `design-prohibitions.json` beside it is the same law typed, and where the two
appear to differ the registry is the one a verb reads.

## The palette is GitHub dark, and the repo is dark-only

`demo/lane-view/style.css` opens with `color-scheme: dark` and defines no light palette. That is a
commitment, not an oversight: the console is furniture in a dark terminal environment. **Do not
improvise a light theme.** If light mode is wanted it is a decision to take deliberately, with a
full second palette, not a `prefers-color-scheme` block bolted onto one component.

The values below are the ones already in the stylesheet. They are named here so new work reaches
for a **role**, never a hex — a raw hex in a new rule is how a fifth grey gets born.

### Surface roles

| Role | Value | Where it belongs |
| --- | --- | --- |
| `canvas` | `#0d1117` | the page body and the stage — the ground everything sits on |
| `chrome` | `#010409` | the strip and the rail — furniture that never moves, recessed *below* the canvas |
| `raised` | `#161b22` | cards, hovered and selected rows, code blocks — anything lifted toward the reader |
| `control` | `#21262d` | button faces |

The ordering is deliberate and inverted from the usual: chrome is **darker** than canvas. Furniture
recedes, content comes forward. A new region that is neither content nor furniture does not exist —
decide which it is before painting it.

### Border roles

| Role | Value | Where it belongs |
| --- | --- | --- |
| `border` | `#30363d` | every region divider, control outline and chip outline |
| `border-subtle` | `#21262d` | separators *inside* a card, between rows of one list |

### Text roles

| Role | Value | Where it belongs |
| --- | --- | --- |
| `text` | `#e6edf3` | body copy, headings, the value inside a count chip |
| `text-secondary` | `#c9d1d9` | a lane's headline in the rail — content, one step back |
| `text-muted` | `#8b949e` | meta, labels, the brand, the source path |

Three steps and no more. A fourth grey is a request to re-read this table, not to add a row.

### Attention roles — the seven states of a lane

`src/chart/lane` derives exactly seven; the console paints six of them and this is the closed set.

| State | Edge | Text | Reading |
| --- | --- | --- | --- |
| `needs-you` | `#d29922` | `#e3b341` | a human is the blocker |
| `tripped` | `#f85149` | `#ff7b72` | the machine hit something it cannot pass |
| `moving` | `#2dd4bf` | — | an agent is driving it right now |
| `done` | `#238636` | — | terminal, succeeded |
| `quiet` | `#8b949e` | — | nothing is owed and nothing is happening |
| `unstarted` | none, `opacity: .55` | — | minted, never driven |
| `unreadable` | **undefined** | **undefined** | the viewer could not parse the lane |

`unreadable` having no paint is a **defect, not a role** — see the prohibitions. It is listed here
because the set is closed and a state omitted from a table is a state that gets forgotten twice.

### Accent roles

| Role | Value | Where it belongs |
| --- | --- | --- |
| `ok` | `#3fb950` | the live heartbeat, a transition that succeeded |
| `interactive` | `#2dd4bf` | hover on anything that sends an event — the same teal as `moving`, because both mean *something is happening* |
| `ref` | `#a5d6ff` | a machine identifier a human did not choose: the driver chip |

### Type roles

| Role | Value | Where it belongs |
| --- | --- | --- |
| `body` | `15px/1.6 ui-sans-serif, system-ui, sans-serif` | prose a human wrote |
| `mono` | `ui-monospace, monospace` | text a **machine** authored or a machine will read: ids, task names, paths, event names, driver sessions, and the buttons that send events |
| `numeric` | `font-variant-numeric: tabular-nums` | any number that changes in place |

The sans/mono split is semantic here, not decorative. Monospace is how the console says *this string
is not for you to interpret, it is for you to copy*.

## The four pillars

### Pillar 1 — The verdict survives the scroll

The console is a fixed viewport split three ways: a strip carrying the rollup, a rail that never
leaves, and a stage taking every pixel left. **The page itself does not scroll**; the rail and the
stage scroll independently. The stylesheet's own comment states the reason: *"reading a 12-task epic
never pushes the lane going amber off the screen."*

A layout change that lets the document scroll breaks the one promise the console makes — that what
is on fire stays visible while you read something else.

### Pillar 2 — Never lose the fleet

At narrow widths the rail becomes a strip **above** the stage rather than collapsing into a menu or
vanishing. The stylesheet says it outright: *"losing the fleet is the one thing this layout exists
to prevent."*

No breakpoint, no drawer, no disclosure control may make the set of lanes invisible. Reachable in
one gesture is not good enough; a lane going amber must be able to catch an eye that was not
looking for it.

### Pillar 3 — Unknown is never rendered as fine

The deepest rule in this repo, and it is not really a visual one — it is the same rule fabrika's own
verbs run on, surfacing at the pixel layer.

Three places in the source already say it. `vite.config.ts`, on a claim it could not read: *"unreadable
is UNKNOWN, and UNKNOWN is not 'nobody' — leave it absent so the page says nothing rather than says
free… Reporting a held lane as free is the one wrong answer here, because it is the answer that gets
a second driver started."* `fleet.ts` mints `attention: "unreadable"` as a first-class state rather
than dropping the lane. The header verdict ranks it last but still shows it: *"a file this viewer
cannot read is our problem, not the operator's — but it still beats claiming all is well while a lane
is dark."*

So: a surface that could not be read renders **differently from a surface that was read and is
clear.** Never the same. Never absent. An empty state and a failed state are two designs, and a
skeleton that never resolves is the failure mode this pillar exists to name.

### Pillar 4 — Colour is a second channel, never the only one

Every state a reader must act on carries at least one non-colour channel: text, position, shape,
weight, or an icon. Colour may reinforce; it may not be the whole signal.

This is the pillar demlik currently violates and the reason it is written strictly. The header
verdict does this right — it says *"3 lanes waiting on you"* in words, and colours the words. The
rail does not: a row's attention state reaches the reader **only** as the colour of a 3px left
border. Two rows differing only in that border are, to a reader who cannot separate amber from
teal, the same row.

The fix is not "add an icon everywhere." It is: for each state, name the channel that carries it
when colour is gone, and check that channel exists.

## Where this manifest is silent, surface the gap

If a surface needs a decision this file does not make — a second page, a data table, a form, a
light theme, a chart — **do not fill the gap from general taste and do not import another repo's
system.** Name the gap in the PR's `## Deviations`, pick the least surprising thing consistent with
the pillars above, and say that is what you did. A pillar invented in a pull request is a pillar
nobody ratified.
