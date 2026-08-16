# TEA Discipline

> The canonical discipline doc for every TEA touch in this monorepo.
> Agents read this BEFORE proposing any TEA-flavored change.
> Engineers read this when they're not sure if their code is correct-shaped.
>
> This doc is the determinism layer around agent indeterminism. If two agents
> disagree on a refactor, this doc is the tiebreaker. If a recommendation
> contradicts a rule here, the recommendation is wrong.

---

## Audience and contract

- **Agents** doing TEA work read this as required reading. Every prompt that asks an agent to audit, refactor, or build TEA code includes this file in its reading list.
- **Engineers** read it when designing a new machine, reviewing a TEA PR, or evaluating an agent's recommendation.
- **The doc is anchored.** Every rule cites the commit (hash) that exemplifies it. If a rule's exemplar commit is reverted or contradicted, the rule is reviewed.

This is the **what** of TEA discipline. The **canon** of operations, and the why behind it, lives in `elm-canon.md`. The **invariants** (1–8, cited throughout) live in `tea-invariants.md`. This doc is the bridge between principle and code.

**Canonical TEA patterns** — `.patterns/tea/patterns/` — 17 pattern files grounded in the official Elm guide, elm-spa-example, elm-community examples, and Elm Radio. Read them for the universal TEA answers; read this doc for how we apply them in this codebase. Start a new machine from `.patterns/tea/machine-template.ts`.

---

## The 8 invariants (one-line restate, cite by number)

1. **Wire boundary parses, core trusts** — `unknown` only at the edges; typed everywhere else.
2. **Pure transitions** — reducer is `(state, msg) → (state, cmds[])`; no fall-through default.
3. **Effects are data** — Cmds describe; `interpret` performs.
4. **External events enter as Subs** — observation only; lifecycle owned by the substrate.
5. **Composition by narrowest typed surface** — sibling runtimes share `RuntimeRef<M>`, not full Runtime.
6. **Runtime is small and inspectable** — every transition observable; no silent failures.
7. **Identity is load-bearing** — Msg.type and State.type at the type level; mapped types enforce.
8. **Store at the boundary** — `Store<S>` parses, the substrate trusts.

The testing discipline — "cross-cell emergent invariants live in property tests, not in cell comments" — is **Rule 4** of this doc, not a ninth invariant. Invariants are properties of the TEA system; rules are engineering practice on top of them.

Every commit message in TEA work cites the invariants it strengthens (e.g., `[invariant 5, 7]`).

---

## Rule 1 — State carries the truth

**The single most important rule.** A reducer cell is correct iff it can be evaluated using only its `(state, msg)` inputs and its return type. If a cell needs to know "what happened before to reach this state" or "what another cell does," the **state shape is incomplete**.

### Apply when:

- A cell makes a decision based on a fact NOT in `state` or `msg`. The fact lives elsewhere (another cell, an external system, a closure).
- You catch yourself writing a comment like *"we don't X here because Y already did it"* or *"this works because of how the substrate orders things."*
- Two cells coordinate via "I know what the other cell will do," not via shared state or a message.

### Don't apply when:

- The dependency is on an **external contract** (chrome API, network protocol) and the cell is a thin adapter at the boundary. Boundary code can trust the contract; document the contract at the boundary.
- The dependency is on a **substrate guarantee** (e.g., `runInterpret` processes Cmds in order) and the guarantee is pinned by a property test in the substrate's own test suite. Trust + test = sufficient.

### Concrete shapes

| Symptom | Fix |
|---|---|
| Cell relies on prior cell having done cleanup | Add a state field that records the cleanup ("queueSettled: true") OR drop the field the cell would have cleaned up ("auditing → done transition consumes queueItemId") |
| Cell relies on closure-scope id threading | Track the id in state (`inFlightToolIds: readonly string[]`) and check membership on return |
| Cell relies on substrate timing (observe-before-resolve) | Pass the post-event value as a Msg payload field |
| Cell relies on cross-cell ordering implicitly | Make the order an explicit state transition (intermediate state between operations) |

### Exemplar commits

- `95ef7137a` — `inFlightToolIds` on auditing state; closure-scope id trust eliminated
- `153aa7450` — payload-based `claim:dispatched`; observer-ordering trust eliminated
- `99bd1b2f8` — `init` made pure; `boot` Msg cell carries the post-resume work explicitly

---

## Rule 2 — Msg arm vs log honestly (the most-violated rule)

**Failures that affect state become Msg arms. Fire-and-forget Cmds log honestly.**

Agents over-engineer this constantly. The discipline is: **does the reducer need to do something with the failure?** If yes, Msg arm. If no, log honestly at the boundary.

### Decision tree

```
A Cmd handler can fail. What do you do?

├─ Can the reducer take meaningful action on the failure?
│   ├─ YES → Add a Msg variant. Dispatch the Msg on failure.
│   │        The reducer's cell decides the next state.
│   │        Example: debugger:attach_failed → bail to idle.
│   │
│   └─ NO  → Log honestly at the boundary. No Msg arm.
│            Distinguish benign errors (expected at teardown) from
│            real failures (logged loudly via console.warn / Sentry).
│            Example: detach_debugger at teardown — reducer has
│            nothing to do with the failure, just log it.
```

### Apply when:

- The failure changes what the machine should do next. The reducer's cell needs to react. → Msg arm.
- The Cmd is mid-flight in a meaningful state and its failure is informative for the next decision. → Msg arm.

### Don't apply when:

- The Cmd is fire-and-forget teardown (detach, close, cleanup). The reducer is already past caring.
- The Cmd is best-effort mid-handler (re-attach during a navigation). The next operation will surface real failures on its own.
- The failure is about an external state we don't control and don't need to model. Boundary log is enough.

### How to distinguish errors at the boundary (not Msg arms)

Many chrome APIs reject promises for both benign and real conditions ("already detached" vs "permission denied"). Boundary handlers should classify:

```ts
// Classifier — names the expected noop cases. Conservatively defaults
// to "real failure" so a new chrome phrase surfaces in the warning log.
function isAlreadyDetachedError(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("already detached") || m.includes("no debugger attached");
}

detach_debugger: async (cmd) => {
  try {
    await chrome.debugger.detach({ tabId: cmd.tabId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isAlreadyDetachedError(message)) {
      console.warn("[detach_debugger] unexpected failure", { tabId: cmd.tabId, message });
    }
  }
  return undefined;
}
```

The classifier is **exported** for unit testing. The set of "noop substrings" is small and growth is conservative.

### Exemplar commits

- `61a20d6d9` — `debugger:attach_failed` Msg arm. CRITICAL failure (audit can't run without debugger). Reducer's cell bails to idle, emits `tearDownAudit`.
- `8d3608485` — `detach_debugger` log honesty. NON-CRITICAL teardown. No Msg arm. Classifier exported.
- `9b247021f` — `forward_tool` re-attach log honesty. Best-effort mid-handler. No Msg arm.

### Anti-pattern (from today's audit)

The smart-to-dumb audit's first proposal added Msg arms for `detach_debugger` and `forward_tool` re-attach. That was wrong — those are fire-and-forget. The TEA gate filtered them down to log-honesty splits.

---

## Rule 3 — Extract helper vs inline (3+ duplicates of the same operation)

A helper is justified when **3+ cells emit the same Cmd sequence representing the same operation**. Cosmetic similarity (two cells happen to emit similar Cmds) is not duplication.

### Apply when:

- N ≥ 3 cells emit the same Cmd array / fragment.
- The operation has a clear name (`tearDownAudit`, `completeAudit`).
- Adding a future variant (e.g., a 4th cleanup step) should touch ONE place, not N.

### Don't apply when:

- Two cells happen to share Cmds but the OPERATIONS are different (one is "cancel an audit," the other is "complete an audit"). Naming the duplication would lie.
- The duplication is one Cmd, not a sequence. Wrapping it is noise.
- The helper would add type complexity (multiple state variants, conditional emission) that costs more than the duplication.

### Helper shape

Returns `readonly C[]`. Takes `state` narrowed via `Extract<S, { type: ... }>` so the type system enforces which state variants can call it. Conditional emission via `Cmd.whenDefined(...)` for nullable fields.

```ts
function tearDownAudit(
  state: Extract<BackgroundState, { type: "auditing" | "connecting" | "initializing" }>,
  status: "cancelled" | "failed",
  error?: string,
): readonly BackgroundCmd[] {
  return [
    ...Cmd.whenDefined(state.queueItemId, (id) =>
      pickDefined({ type: "queue:complete", queueItemId: id, status, error })
    ),
    ...(state.type === "auditing" ? [{ type: "detach_debugger", tabId: state.tabId }] : []),
    { type: "close_audit_window", windowId: state.windowId },
  ];
}
```

### Exemplar commit

- `f301a0089` — `tearDownAudit` + `completeAudit`. 9 cells collapsed to one-line calls. Reducer.ts shrunk 120 LOC.

### Anti-pattern

Resist extracting "wrapper" helpers that hide behavior the reader needs to see. The earlier `cleanupCmds` helper in reducer.ts was removed for being "a 3-line wrapper that hid nothing." It was correct to remove THEN; it became correct to add back when the cleanup grew to THREE distinct domain operations.

---

## Rule 4 — Property test vs comment vs nothing

When you discover an invariant the code depends on, you have three responses. Pick by where the invariant lives.

### Cross-cell emergent invariant → Property test

The invariant spans multiple cells. No single cell can express it. The property test OWNS the invariant; cells CITE it.

Example: "From `idle`, the machine never reaches `done` without passing through `auditing`." No single cell can prove this; the property test does.

Use `@demlik/tea/pbt`'s `propertyTrace`, `propertyInvariant`, `propertyTerminates`.

### Substrate or external contract → Comment + (optional) test in substrate

The invariant lives in another module's source code or external API documentation. Comment the dependency at the cite site; optionally pin via a test at the source.

Example: `runInterpret` processes Cmds sequentially with `await`. The cell relying on this should comment the dependency; the substrate's `run.spec.ts` should pin the contract.

### Already pinned by an existing test → Nothing

The invariant is already CI-enforced. Don't add another test. Comments are optional.

### Decision tree

```
You found an invariant the code relies on. Where does it live?

├─ Emergent from N cells in this reducer → Property test (cross-cell)
├─ A specific cell or function explicitly enforces it → Comment at the cell + (optional) unit test
├─ The substrate enforces it → Comment at the cite site + test in substrate
├─ An external API enforces it (chrome, network) → Comment at the cite site
└─ Already pinned by an existing test → Nothing
```

### Exemplar commits

- `9dc206dea` — Property 1 in discovery PBT tightened to pin "done is only reached via ws:audit:done." Cross-cell emergent invariant.
- `153aa7450` (substrate part) — Property test in `packages/tea/test/run.spec.ts` pinning "observers fire before dispatch resolves." Substrate contract.
- `6a4d30318` — Property test pinning the tool-executor's shell-serializes guard. The CONTRACT is implicit; the test makes the behavior CI-enforced.

### Anti-pattern

Don't add a property test for every implicit invariant. If the invariant is structural (enforced by mapped types) or already pinned by another test, adding another is noise.

---

## Rule 5 — Cmd discipline

Cmds are data. The `interpret` handler PERFORMS. The reducer EMITS.

### Apply:

- Side effects (chrome API calls, WS sends, timer starts) live ONLY in `interpret`. The reducer never calls chrome or sends WS messages.
- Cmds are pure data: `{ type, ...fields }`. No closures, no functions.
- Cmd handlers are async and can return `Promise<M | void>`. The follow-up Msg is enqueued for the next tick.
- If a Cmd handler fails, see Rule 2 for whether to dispatch a Msg arm or log.

### Don't:

- Don't pack closures or functions into Cmd payloads.
- Don't perform side effects in the reducer or in Sub handlers (Sub handlers OBSERVE; they dispatch Msgs).
- Don't make Cmds carry state the reducer should own.

### Exemplar commit

- `bab9a4dc8` — `send_ws` Cmd carries `auditId`; handler does `wsRegistry.get(wsSubId(auditId))`. State (the cell emitting the Cmd) carries the routing key; Cmd transports it; handler uses it deterministically.

---

## Rule 6 — Cross-cell trust patterns (and how to break them)

The audit pattern we used twice (yesterday + today). Every cell should be readable in isolation. When you read a cell, ask: *"Can I tell this cell is correct from (state type, msg type, return type) alone?"* If no, you've found a trust dependency.

### The 6 patterns (from the audit rubric)

| # | Pattern | Fix |
|---|---|---|
| A | Cross-cell trust without state | Move the trust into a state field |
| B | Closure-scope id/value trust | Track in state, check on return |
| C | Timing / ordering trust | Payload-based determinism, or pin the substrate contract |
| D | Silent error swallow | Either Msg arm (Rule 2) or log honestly (Rule 2) |
| E | Duplication-as-coupling | Extract a named helper (Rule 3, only if 3+) |
| F | Defensive code for impossible cases | Trust the type system; delete the branch |

### How to audit existing code

For each cell in a reducer:

1. Read it. Ask: *"Could a future change to ANOTHER cell silently break this?"*
2. Categorize: CONFIRMED (real risk) / MILD (locally explainable) / NIT (cosmetic) / CLEAN.
3. Apply the right rule for the bucket:
   - CONFIRMED → refactor (which pattern? A, B, C, D, E, or F).
   - MILD → comment at the cell + (optional) property test.
   - NIT → nothing.
   - CLEAN → don't waste lines saying so.

### Exemplar audits

- `1988cc58c` — 8 broad invariants over `auditBackgroundMachine`. 7 passed; 1 was over-claiming (property tightened, not code changed).
- Today's audit punch list (this conversation, no commit) — 11 confirmed smells, 9 mild, 5 nit; 4 chosen for refactor based on TEA discipline.

---

## Rule 7 — When NOT to refactor

The hardest rule for agents. **Sometimes the current pattern is correct.**

### Don't refactor when:

- **The dependency is on a substrate contract pinned by a test.** Trust + test = sufficient. Adding a comment at the cell is fine; adding another test is noise.
- **The Cmd is fire-and-forget.** Don't add Msg arms (Rule 2).
- **The duplication is < 3.** Don't extract helpers (Rule 3).
- **The boundary parser silently falls back to a safe default.** Boundary parsers SHOULD be defensive — `parseBackgroundState` returning `null` for invalid input and `chromeStorageStore` booting fresh is correct.
- **The handler swallows errors that are genuinely benign.** Detach at teardown swallowing "already detached" IS correct; the fix is distinguishing benign from real (Rule 2), not removing the catch.
- **The invariant is already pinned.** Don't add another property test for the same invariant.

### Anti-pattern from today's audit

The audit agent suggested:
- Msg arms for `detach_debugger` and `forward_tool` re-attach. **Rule 2 says no.**
- Emitting full audit state on every transition for hypothetical future consumers. **YAGNI.**
- A `tool:queueing_error` Msg arm for the tool-executor guard. **Rule 2 says no; pin the contract via PBT instead.**

The TEA gate caught these. This doc exists so future agents catch them automatically.

---

## How to audit existing code (procedure)

1. **Define scope** — which files? Which machines? Be explicit.
2. **Required reading** — every reducer, every Cmd handler, every Sub handler in scope, plus the type files (events, phases, effects), plus this doc.
3. **For each cell**, apply the 6 patterns from Rule 6. Categorize CONFIRMED / MILD / NIT / CLEAN.
4. **For each CONFIRMED finding**, decide which rule applies (1–7). Produce a punch list item.
5. **Do NOT propose fixes for MILD or NIT**. Document them; leave the decision to the engineer.
6. **Cite invariants** in the punch list. Cite exemplar commits where the same pattern was fixed before.
7. **Output is a markdown punch list**. No code changes. The engineer (or a follow-up agent) decides what to refactor.

---

## How to implement TEA work (procedure)

1. **Required reading** — this doc + the specific files being modified + recent commits touching them.
2. **Layer-by-layer build**:
   - Types first (events, phases, effects).
   - Reducer cells second.
   - Cmd handlers third (`interpret`).
   - Sub handlers fourth (where applicable).
   - Tests fifth (existing tests still pass; new tests pin new behavior).
3. **Verify per layer**: `pnpm typecheck` after types; `pnpm test` after each cell/handler change.
4. **One commit per logical unit**. Don't bundle. Each commit independently typechecks and tests-passes.
5. **Cite invariants** in commit messages: `[invariant 5, 7]`.
6. **NO `as any`, NO `@ts-ignore`.** Use `Extract<...>` and discriminated narrowing.
7. **If a design decision arises**, apply the rules in this doc BEFORE recommending. If this doc doesn't address it, flag the gap.

---

## Required reading for any TEA-touching agent

Every agent prompt that asks an agent to audit, refactor, build, or review TEA code MUST include:

```
1. .patterns/tea/tea-discipline.md    (this file — discipline rules)
2. .patterns/tea/tea-invariants.md    (the 9 invariants in detail)
4. .patterns/tea/elm-canon.md         (the operations canon)
5. src/index.ts                       (the substrate's actual code)
6. The specific machine files being touched
7. The relevant tests so the agent doesn't duplicate or break them
```

The agent's first response must be a brief (5–8 bullets) demonstrating it read this material. If the brief is missing or shallow, the agent's recommendations are not trusted.

---

## Glossary

- **Cell** — One entry in the `Transitions` table or `Reducer` record. A pure function `(state, msg) → (state, cmds)`.
- **Cmd** — Data describing a one-shot effect. Performed by `interpret`. Examples: `send_ws`, `attach_debugger`, `close_audit_window`.
- **Msg arm** — A new variant in the Msg union representing a typed event. Adding one forces every (state.type × Msg variant) cell to handle it.
- **Sub** — Long-lived subscription (WebSocket, chrome.alarms). Spawned/torn down by the substrate's reconcile loop. Observes external events and dispatches Msgs.
- **Fire-and-forget** — A Cmd whose failure doesn't affect state. Examples: detach at teardown, close-window. Log honestly; no Msg arm.
- **Property test** — A `fast-check`-driven test that asserts an invariant holds across generated input sequences. Owned by `@demlik/tea/pbt`.
- **Non-local reasoning** — A cell that requires knowledge of other cells to be evaluated. The primary anti-pattern this doc exists to eliminate.
- **Closure-scope trust** — A cell or handler that relies on a value being correct because of where the value came from (dispatch chain origin, function arg), not because of any local check. See Rule 6 Pattern B.
- **Boundary parse** — `unknown` → typed conversion at the wire/disk boundary. Invariant 1. Defensive fallbacks here are correct.

---

## Living doc

When a new TEA pattern emerges OR an existing rule needs revision:

1. Open a PR modifying this doc.
2. Cite the exemplar commit (or PR introducing the change).
3. If the change contradicts an existing rule, explicitly resolve the contradiction.
4. Reviewers check against the existing exemplars.

Every TEA agent reading this on the day of the PR sees the new rule. No drift.

---

## Commit anchor

The exemplar commits referenced in this doc:

| Commit | Rule it exemplifies |
|---|---|
| `99bd1b2f8` | Rule 1, Rule 5 — `init` pure, `boot` Msg cell |
| `1ed4c12df` | (design doc for `@demlik/tea/pbt`) |
| `f301a0089` | Rule 3 — `tearDownAudit` + `completeAudit` helpers |
| `95ef7137a` | Rule 1, Rule 6 Pattern B — `inFlightToolIds` state |
| `153aa7450` | Rule 1, Rule 6 Pattern C — payload-based `claim:dispatched` + substrate observe-before-resolve test |
| `9dc206dea` | Rule 4 — Property 1 tighten |
| `61a20d6d9` | Rule 2 — `debugger:attach_failed` Msg arm (CRITICAL failure) |
| `bab9a4dc8` | Rule 5, Rule 6 Pattern A — `send_ws` carries auditId |
| `8d3608485` | Rule 2 — `detach_debugger` log honesty (FIRE-AND-FORGET) |
| `9b247021f` | Rule 2 — `forward_tool` re-attach log honesty (FIRE-AND-FORGET) |
| `6a4d30318` | Rule 4, Rule 7 — Property test pins shell-serializes contract instead of Msg arm |
| `1988cc58c` | Rule 6 — Discovery PBT, 8 broad invariants over the audit machine |

If you add an exemplar, append here. If you remove a rule, mark the exemplar as superseded.

---

End.
