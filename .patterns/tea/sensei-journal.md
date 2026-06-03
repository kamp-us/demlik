# TEA Sensei Journal

A growing database of mistakes, problems, and right-shape patterns observed across TEA work in this monorepo. Newest entries on top. Append-only.

This is the `tea-sensei` agent's learning database. Every time the agent observes a pattern, mistake, or smell that isn't already here, it appends a new entry. Reading this file at the start of every TEA task lets the agent recognize recurring shapes faster than re-deriving them.

**Entry format** (byte-for-byte):

```
## YYYY-MM-DD — Short title

**Trigger:** what I saw (concrete, one sentence)
**Mistake:** what was wrong (cite invariant N if mapped)
**Right shape:** the fix (concrete, one or two sentences)
**Smell to remember:** the pattern next time (one phrase you'd grep for)
```

**Append-only.** Past entries are never edited. If a past entry is wrong, write a new entry that supersedes it and references the old by date.

**Authority for invariant numbers:** `.patterns/tea/tea-invariants.md`.

---

## 2026-06-01 — Optional state field as the install-guard for a peer-dependent Sub

**Trigger:** Plan 2 added a half-open-lease alarm on `audit-agents.running`. The brain has two hands clients with asymmetric heartbeat behavior — the extension pings every 20s; the container never pings (no heartbeat in container/server.ts). If the lease alarm armed unconditionally on `running`, every container audit would falsely trip it within LEASE_MS of becoming running.
**Mistake:** Two tempting wrong shapes. (1) A `clientType` discriminator on `running` to gate the lease — but that's modeling the *peer*, not the *fact* the reducer cares about. (2) A `leaseArmed: boolean` flag the reducer flips on ws:ping — works, but it's redundant with `lastPingAt`, and now two fields must stay coherent (invariant 1: state is value, not place). Either path silently couples the reducer to the peer's product behavior.
**Right shape:** `lastPingAt?: number` — optional, UNSET until the first ping arrives. `subscribe.ts` keys the lease `do_alarm` off `state.lastPingAt + LEASE_MS` ONLY when `lastPingAt !== undefined`. The field is *both* the witness ("did we ever see a ping?") and the deadline source ("when should the lease fire?") — one field, one truth. Container audits never set it → lease stays uninstalled. Extension audits set it within one heartbeat → lease arms; subsequent pings re-render with a slid-forward firesAt (substrate reconciles by id — same shape as the grace alarm). When the lease fires, `disconnectedAt = lastPingAt + LEASE_MS` is computed from state (invariant 2 — no Date.now in reducer).
**Smell to remember:** "discriminator on the peer instead of on the observation" — if you're tempted to add `clientType`/`hasHeartbeat`/`isExtension` to a phase to gate a Sub, the right shape is usually an optional witness field whose presence the Sub guards on. The field unifies "is it on?" with "what does it carry?"; the guard is one line in `subscribe.ts`.

Commit: Plan 2 brain half-open lease

---

## 2026-06-01 — Sub owns the reconnect lifecycle; reducer mirrors via Msg

**Trigger:** Plan 3 needed WebSocket auto-reconnect-with-backoff on the extension side. Three places it could live: (a) `BackgroundState` (attempt counter, next-retry-at), (b) a `reconnect_ws` Cmd handler driving its own loop, (c) the ws Sub's closure.
**Mistake:** (a) and (b) both push timing/scheduling into the reducer or Cmd layer — Date.now-equivalents creep in, and the reducer ends up with mutable scheduling state the substrate doesn't need to see. (a) also makes resume-after-SW-restart awkward (do we persist `nextRetryAt`? what about a wall-clock skew?). (b) violates invariant 4 (external time/lifecycle is a Sub concern) by reimplementing what `fromInterval` already establishes for the heartbeat Sub.
**Right shape:** The ws Sub's closure owns `attempt`, `timer`, `tornDown`. Each scheduled retry dispatches a typed Msg (`ws:reconnecting{attempt}`) so the reducer can flip the user-visible `connection: { type: "reconnecting", attempt }` sub-state. The same key (`wsSubId(auditId)`) re-registers the new socket so `sendOnLiveWs` keeps resolving. On give-up the Sub falls back to the canonical `ws:close` Msg — the existing teardown cell handles the rest, no new "ws:budget_exhausted" arm needed. Identity-load-bearing: `sessionId` lives on persisted state (so SW restart preserves it) and on the Sub variant (so it's appended as `?sessionId=` per connect attempt).
**Smell to remember:** "reconnect/backoff state on the reducer" — if you're adding `attempt: number` + `nextRetryAt: number` to a phase, the Sub's closure is the right home; mirror only the user-visible projection into state via a Msg.

Commit: Plan 3 extension reconnect + sessionId

---

## 2026-05-22 — `init` is where a stuck-at-running becomes observable

**Trigger:** `audit-agents`' DO held the audit lifecycle in 6+ mutable instance fields. On hibernation, the JS heap is lost — `pendingToolCall`'s in-memory `Map<id, resolve>` dies — and the audit silently wedged at `running` forever; the dashboard saw it done, the extension saw it auditing.
**Mistake:** Lifecycle truth lived in `place` (instance fields), not in a persisted `value` (invariant 1). Resume could not reason about a state it could not see (invariant 1, 7) — there was no `interrupted` name for the wedge (invariant 7).
**Right shape:** One persisted `AuditState` union in `doStore`. `init(loaded, ctx)` inspects the rehydrated state: `running` + non-empty `pendingToolCalls` + no live tool-client WS ⇒ return `interrupted`. The Promise-resolver `Map` stays in-memory and intentionally dies; `pendingToolCalls: readonly string[]` lives in durable state so resume can detect the gap. `init` stays pure — it returns `[interrupted, []]`, never a Cmd (invariant 2); the interruption *event* (KV write, SSE emit) is a `boot` Msg dispatched once after `run()` returns.
**Smell to remember:** "lifecycle field that dies with the isolate" — grep DO classes for `private pending* | private *Ws | private phase` holding cross-request truth.

Commit: B8E-1108 — feat(audit-agents): migrate outer orchestration to @demlik/tea

---

## 2026-05-21 — Seeded from five shipped refactors

The journal opens with five entries distilled from commits shipped through 2026-05-20. Each one is a "right shape" pattern with a name. Future tasks can grep for the smell phrase or cite the SHA.

---

## 2026-05-21 — React handler calling Cmd-domain I/O bypasses the reducer

**Trigger:** `QueueTab.tsx`'s per-row remove / retry buttons called `queue.removeItem(id)` / `queue.retryItem(id)` directly from React onClick handlers, while sibling buttons in the same component (Show / Close window) routed through the bridge dispatch. Two paths existed in one component for "user-gesture that mutates external state."
**Mistake:** A React onClick that performs I/O outside the machine bypasses the reducer's Msg log (invariant 6 — every transition observable). The user's *intent* is unobservable; replay can't reach the click; `runtime.observe` never sees it. The "side effect comes back through a Sub" loop closes the data flow but leaves the intent uncaptured.
**Right shape:** React dispatches a `*_clicked` Msg; the reducer emits a domain Cmd; interpret performs the I/O. Pair each Cmd with a `*_failed` Msg arm per Rule 2 so the surface receives a typed error event, not a silent rejection. The Sub still fans the resulting world-change back through (e.g. `items_changed`) — both paths coexist; the Msg/Cmd path captures *intent*, the Sub captures *world state*.
**Smell to remember:** "React onClick calls a Cmd-domain I/O method directly" — grep for `.tsx` onClick handlers calling library / boundary functions (`queue.X(`, `chrome.X(`, `wsRegistry.X(`) instead of `dispatch({ type: "*_clicked", ... })`.

Commit: `555262f66` + `4bfe7e5ff` — feat(extension): remove/retry queue mutations land as Msgs + Cmds + consumer flip.

---

## 2026-05-20 — `debugger:attach_failed` Msg arm — explicit bail beats silent wedge

**Trigger:** The audit flow could wedge in an `attaching` phase if the debugger attach Cmd failed. The Cmd had no failure Msg variant; the failure just disappeared.
**Mistake:** A Cmd that can fail without a paired failure Msg variant violates invariant 6 (runtime introspection — every transition observable) and invariant 7 (identity — the failure has no name). The reducer cannot react to a failure it cannot be told about.
**Right shape:** Every failable Cmd gets a paired failure Msg variant. `attach_debugger` → `debugger:attached | debugger:attach_failed`. The phase that initiates the Cmd handles both arms, with the failure arm transitioning to a terminal or recoverable state — never staying in the attaching phase silently.
**Smell to remember:** "Cmd without a paired failure Msg arm" — grep for Cmds whose `into` only carries the success shape.

Commit: `61a20d6d9` — feat(extension): debugger:attach_failed Msg arm

---

## 2026-05-20 — Property 1: pin sole-entry invariants

**Trigger:** PBT had a Property claiming `ws:audit:done` reached the terminal `done` state, but did not assert that it was the *sole* entry. A second path could reach `done` and the Property would still pass.
**Mistake:** A Property that asserts "X reaches state S" is weaker than "X is the only entry to S." Without the sole-entry pin, a hidden race or a duplicate transition can land in S undetected — invariant 7 (identity drift).
**Right shape:** When a terminal state has one canonical entry, the Property asserts both reachability *and* uniqueness. The reducer should compile-prevent other entries when possible (a phase that can only transition to `done` via the canonical Msg), and PBT pins the property when compile-prevention is partial.
**Smell to remember:** "Property pins reachability but not uniqueness" — every terminal state needs both Properties or a comment explaining why uniqueness isn't load-bearing.

Commit: `9dc206dea` — test(extension): tighten Property 1

---

## 2026-05-19 — Payload-based `claim:dispatched` + substrate observe-before-resolve test

**Trigger:** A Cmd tag (`claim:dispatched`) was being treated as identity on its own, with the actual claim payload carried implicitly via closure. The substrate observer fired *after* the Cmd's promise resolved, so devtools missed the dispatch moment.
**Mistake:** A Cmd whose identity is its tag (not its payload) leaks information to closures and makes child-Msg composition (invariant 5) ambiguous — the parent can't wrap a tag without inventing payload. Separately, observe-after-resolve violates invariant 6 (every transition observable) — a transition that completed before observe ran is invisible.
**Right shape:** The Cmd carries its payload explicitly: `claim:dispatched` has `{ type, payload: { claimId, tool } }`. Parent wraps the child Cmd via `cmd => ({ type: "child", cmd })` and the payload survives the wrap. The substrate test pins observe-before-resolve as a substrate property — any observer registered before the transition sees it land before the Cmd promise resolves.
**Smell to remember:** "Cmd identity in the tag, payload via closure" — grep for Cmd handlers that read variables from outer scope instead of `cmd.field`.

Commit: `153aa7450` — refactor(extension,tea): payload-based claim:dispatched

---

## 2026-05-18 — `inFlightToolIds` on auditing state — closure-scope ids are a smell

**Trigger:** An audit phase tracked which tool invocations were "in flight" via a `Map` held in the interpret handler's closure. The reducer could not query or assert about in-flight ids, only the closure could.
**Mistake:** State held in closure scope is state outside the value (invariant 1) and identity outside the type (invariant 7). The reducer cannot reason about state it cannot see. Worse, a stale closure (after rehydrate) holds stale ids forever.
**Right shape:** In-flight ids live on the auditing state: `state.auditing.inFlightToolIds: ReadonlySet<ToolId>`. The reducer adds an id when dispatching a tool Cmd, removes it when the tool's Msg lands. Init's rehydrate branch resets the set to empty (invariant 2 — pure rehydrate). The interpret handler reads ids out of the Cmd payload, never out of closure.
**Smell to remember:** "Map / Set in interpret closure tracking machine state" — grep `interpret.ts` for module-scope or function-scope mutable collections.

Commit: `95ef7137a` — refactor(extension): inFlightToolIds on auditing state

---

## 2026-05-17 — `tearDownAudit` + `completeAudit` helpers — duplication-as-smell collapses

**Trigger:** Nine phase cells across `auditBackgroundMachine` each performed the same teardown sequence (detach debugger, clear in-flight ids, transition to idle). The repetition compiled but obscured the fact that all nine were the same operation.
**Mistake:** Duplicated cells don't violate a *named* invariant directly, but they make invariant 6 (runtime introspection) practically harder — when you observe a teardown, you can't tell which of nine cells fired it without reading the diff. Duplication also creates drift risk: one cell fixes a bug, the other eight forget.
**Right shape:** Helper functions in the machine module: `tearDownAudit(state, msg, cmds)` and `completeAudit(state, msg, cmds)`. Each cell calls the helper and adds any cell-specific Cmd. The helper is pure (returns `[State, Cmd[]]` slices the caller folds in); it does not perform effects. Nine cells collapse to nine one-liners.
**Smell to remember:** "Same teardown sequence in 3+ phase cells" — grep for duplicated `detach_debugger` Cmd emissions or duplicated `clear in-flight` reducer slices.

Commit: `f301a0089` — refactor(extension): tearDownAudit + completeAudit helpers

---
