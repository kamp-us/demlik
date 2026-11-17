# Later-answer verification

Baseline: `d87f2d8f`. Implementation and recipe: `a7bf32f5`, `f81c0e9b`.
Final test refinements: `7d6eade5`. Branch: `can/answer-later`.
Initial status was empty and the branch was asserted before reading the five latest commits.
All commits use the repository's configured identity. Nothing was pushed, posted, or published.

## Public option and ownership

`DispatchOptions.answerTo?: DeliveryId`, shared by Promise and Effect dispatch.
The answer is built with the exact persisted Cmd's `ok` or declared `err` builder.
`LogMessage.answerTo` records its receipt in that admission, with no new record kind.
Combining `answerTo` with caller `id`, or using it without a log, is refused.

| Table or boundary | Extended rows | Source coordinate |
| --- | --- | --- |
| Cmd contract | `answer`, outcome rows `Ok`, `Err`, using existing `mint` | `packages/tea/src/pure/core.ts:584`, `:601` |
| Built-in extension | `cmdDefinitions.answer` | `packages/tea/src/internal/engine/builtins.ts:180` |
| Engine boundary interpreters | integer `ok` / `invalid_integer`; answer `owed` / `repeat` / `refused` | `packages/tea/src/internal/engine/loop.ts:1082`, `:1098` |
| Codec parsers | existing `message` row parses optional positive-safe-integer `answerTo` | `packages/tea/src/internal/persistence/durable-log/codec.ts:138`, `:92` |
| Codec protocols | readers `2` / `3`; answer-only writer selection | `packages/tea/src/internal/persistence/durable-log/codec.ts:219`, `:246` |
| Operations | `append_message`, translating pure `decideAnswer` through `owed` / `repeat` / `refused` rows | `packages/tea/src/internal/persistence/durable-log/operations.ts:171`, `:180`; owner `:22` |
| Projection folds | `message` consumes its delivery and retains pending input; `confirmed` shares `confirm` | `packages/tea/src/internal/persistence/durable-log/projection.ts:260`, `:285`; interpreter `:221` |
| Ledger readers | `logLedger`'s `message` folds the confirmation fact through the existing ledger | `packages/tea/src/internal/persistence/durable-log/format.ts:52` |
| Refusal messages | `unknown_answer` | `packages/tea/src/internal/persistence/durable-log/refusals.ts:3` |

Admission preparation preserves the existing source order when an ordinary message arrives
while an answer is being parsed. The new concurrent-arrival test failed with
`Commit requires the first pending source` before that ordering fix, then passed on both engines.

## Outcomes

Every case below passes on both engines in the shared per-call fixture.

| Case | Positive and negative evidence |
| --- | --- |
| First owed answer | One admission carries its receipt, folds the result, and clears owed; no separate `confirmed` record. Ordinary admission cannot clear it. |
| Duplicate | Hot and cold repeats, including conflicting ok/err payloads, retain the first result and write nothing. |
| Unknown | Refused without writing; the valid owed id then succeeds on the same activation. |
| Malformed | Wrong builder tag, rejected ok value, undeclared err tag, mismatched Cmd, or nonfinite reply time writes nothing; each corrected answer succeeds on the same activation. |
| Caller id | An ordinary answer-shaped Msg with caller `id` leaves both identical Cmd deliveries owed; `answerTo` independently clears each, out of order. |
| Cut after admission | The real append completes, then the activation is interrupted before reduction. Wake folds the answer without re-handing the Cmd. A reducer refusal instead writes its existing rejected receipt and still leaves nothing owed. |

Invalid delivery ids, storeless answers, and `answerTo` plus `id` also have refusal and valid-call controls.

## Fifty-call history

The first new test extended `per-call-host.fixture.ts` before implementation. It failed on
all four engine/driver combinations because the first later answer left its delivery owed.

The final [captured counts](./fixture-counts.jsonl) cover Promise/Effect times memory/file:
each run has 50 measured closed calls, nine unique handoffs, 25 stable-id re-hands,
nine answers delivered 1 to 5 calls later, seven deadline messages, and zero final owed entries.
All 200 calls assert zero measured handles, timers, pending Promises and Effect fibers,
zero engine live work, and exact equality between surviving ledger entries and externally
handed work not yet answered. Every handler call checks that its id was never answered.
Each final State equals both an independent expected State and a continuous control
using the same engine and journal driver. The final focused run passed 96 tests in five files.

## Wire evidence

`fixtures/protocol-2.json` was encoded by the actual codec read from `git show
d87f2d8f:packages/tea/src/internal/persistence/durable-log/codec.ts`, bundled with its
baseline refusal module. Its birth/message/applied bytes read unchanged in the new code;
re-encoding them produces identical bytes. The new codec's tests assert ordinary frames
remain protocol 2, answer-bearing frames use protocol 3, and the new reader accepts both.

The same archived reader was executed against a protocol-3 answer frame. Its
[captured result](./old-reader.json) is `unsupported_log_protocol`, with no silent loss
of `answerTo`. Checkpoint protocol remains 2.

## Requested gates

| Command | Exit | Evidence |
| --- | --- | --- |
| `pnpm typecheck` | 0 | `packages/tea/dist` moved aside for the entire command, then restored; rerun after final test refinements |
| `pnpm typecheck:test` | 0 | Whole workspace test program, rerun after final test refinements |
| `pnpm lint` | 0 | Three warnings before and after, all unchanged |
| `pnpm --filter @demlik/tea run build` | 0 | JavaScript and declarations built |
| `pnpm --filter @demlik/tea run verify:exports` | 0 | 54 export targets; published journal recovery and kit boundaries pass |
| `pnpm --filter @demlik/tea run typecheck:consumers` | 0 | Published Promise/Effect pass/fail examples, including numeric `answerTo` |
| `pnpm --filter @demlik/tea run docs:reference:check` | 0 | Regenerated references have no diff; no generated page edited by hand |
| `pnpm --filter @demlik/tea exec vitest run src/docs --maxWorkers 2 --no-file-parallelism` | 0 | After build: [27 files, 207 passing tests, one existing skip](./docs.log) |
| `TEA_API_BASE=origin/main pnpm --filter @demlik/tea run api:ratchet` | 0 | Base `898e32966d35`; 33 changed published names, one minor changeset; same one tsgo diagnostic on each side |
| `pnpm exec vitest run scripts/no-per-test-timeout.test.mjs` | 0 | Three tests; unchanged timeout policy |
| Runtime command below | 0 | [63 files and 1,387 tests pass](./runtime.log), including both import graphs and all requested contract directories |

```sh
pnpm --filter @demlik/tea exec vitest run --maxWorkers 2 --no-file-parallelism \
  src/new-source-boundaries.test.ts src/pure/import-graph.test.ts \
  src/entry-points.import-graph.test.ts src/internal/persistence src/effect src/mem \
  src/node/durable-log.contract.test.ts src/typed-cmd-channels.test.ts
```

The docs recipe's first sandbox invocation exited 1 with `uv_uptime` EPERM in existing
`src/node/file-lock.ts:107`. The whole docs suite and runtime contracts passed with approved
local host access. No socket failure remained. An earlier broad run exited 1 with the new
guard's synthetic-import false positive and one unchanged Effect crash test's five-second
timeout; its [raw result](./first-runtime-attempt.log) is retained. The fixture text was fixed
and the full command rerun without simultaneous docs work. No timeout or existing assertion
was modified. Intermediate implementation test failures remain in the session's temporary logs.

## Unchanged boundaries and assertion audit

```sh
git diff --stat d87f2d8f..HEAD -- packages/tea/src/internal/journal packages/tea/src/node/index.ts
```

Exit 0, empty output. Journal contract, drivers and conformance kit have no changes.

```sh
git diff d87f2d8f..HEAD -- packages/tea/src | grep -E "^[-+].*expect\("
```

Exit 0. [Exact stdout](./assertions.diff): 96 added lines and zero removed lines.
All hits are in new files or new test cases except these four new assertions extending
the existing executable recipe with the requested answer side:

| Source | Added assertion | Why |
| --- | --- | --- |
| `src/docs/how-to/make-durable.test.ts:323` | `expect(stillOwed).toEqual([])` | Admission cleared the delivery |
| `src/docs/how-to/make-durable.test.ts:324` | `expect(rt.getState().settled).toEqual(["report-ready"])` | Later answer folded |
| `src/docs/how-to/make-durable.test.ts:340` | `expect(wake.getState().settled).toEqual(["report-ready"])` | Result survives wake |
| `src/docs/how-to/make-durable.test.ts:341` | `expect(handed).toHaveLength(3)` | Final wake never re-hands answered work |

Every pre-existing assertion is unchanged. The source-boundary test includes planted
fail cases for package-name self imports, Effect imports outside its homes, and environment
reads below an edge, and checks all newly added source files. Existing import-graph tests
and the describe-only timeout guard pass without changes.

## Verification boundary

No required work remains. Local journals and real file I/O are verified. Actual platform
eviction, remote worker/receiver behavior, platform alarms, cloud/SQLite versions of this
new fifty-call history, and production rollout were not exercised. No push, pull request,
merge, deployment, publishing, or external message occurred.
