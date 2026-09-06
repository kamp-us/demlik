---
"@demlik/tea": patch
---

The hand-authored Diátaxis quadrants catch up with the doors the internalization epic closed
(ADR 0015, ADR 0016). No behaviour changes; every page under `docs/tutorial/`, `docs/how-to/`
and `docs/explanation/` now names only a subpath `package.json` `exports` still carries.

Six how-tos are retired, each because its *subject* module is now `src/internal/` and the guide
cannot be followed at all:

| Retired page | Subject door, now internal | Where the capability is |
|---|---|---|
| `docs/how-to/call-an-authenticated-api.md` | `@demlik/tea/authed-call` | `src/internal/resilience/authed-call` |
| `docs/how-to/retry-until-it-succeeds.md` | `@demlik/tea/retry-to-success` | `src/internal/resilience/retry-to-success` |
| `docs/how-to/await-a-terminal-state.md` | `@demlik/tea/await-terminal` | `src/internal/flow/await-terminal` |
| `docs/how-to/batch-work-into-windows.md` | `@demlik/tea/batch-window` | `src/internal/flow/batch-window` |
| `docs/how-to/debounce-input-durably.md` | `@demlik/tea/throttled-input` | `src/internal/timing/throttled-input` |
| `docs/how-to/reconcile-desired-state.md` | `@demlik/tea/reconciler` | `src/internal/flow/reconciler` |

Their `docs/how-to/index.md` rows go with them. For a retry ladder from outside the package the
public route is `@demlik/tea/retry-backoff` — [Add retry and backoff to a
call](../docs/how-to/add-resilience.md) — and the L2 intent layer is where these jobs come back.

Pages that only mentioned a closed door keep their subject and lose the specifier:
`gate-a-refactor-on-parity.md` now keeps its golden as plain JSON through `@demlik/tea/parity`
rather than re-hydrating JSONL with the internal `parseJSONL`; `replay-in-a-test.md` points at
`parity` for the record-then-replay loop; `add-resilience.md` drops the wrapper section, whose
`createPoller` / `withResilience` are both internal now; and the deadline Sub is named as a
behaviour where no public specifier exists for it.

`src/docs/doc-specifiers.test.ts` is the guard so it does not recur: it fails when any
hand-authored `.md` under `docs/` names a `@demlik/tea/*` specifier the export map does not
carry.
