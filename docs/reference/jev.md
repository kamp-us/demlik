# @demlik/tea/jev

> ask TypeSafe **Jev** (System One) a map of typed questions and get a typed answer back under each name: the wire contract, the one Cmd that issues the call, and the batching composition over it.

```ts
import { … } from "@demlik/tea/jev";
```

## Exports (62)

| Symbol | Kind | Summary |
| --- | --- | --- |
| `Batch` | Interface | One flushed batch, as plain data: the items and the id fan-out addresses it by. |
| `ClassifyBatchCmd` | Type | The Cmd a flushed batch becomes — `../ask`'s, carrying the native request. |
| `ClassifyBatchConfig` | Interface | The knob. |
| `ClassifyBatchErrMsg` | Type | The failure settle Msg — `../ask`'s, with the typed JevAskErr. |
| `ClassifyBatchKnob` | Type | The bound knob createClassifyBatch returns. |
| `ClassifyBatchOkMsg` | Type | The success settle Msg — `../ask`'s, with the batch's answers. |
| `ClassifyBatchState` | Interface | The slice: the three batteries' own slices, plus the one fact none of them holds — which keys a failed batch left unanswered. |
| `ClassifyCriteria` | Type | The rubric every item is classified against: option key → description, or `null` where an option needs no extra detail. |
| `classifyStatus` | Function | Classify one HTTP status, per the reference page's error table. |
| `createClassifyBatch` | Function | Build a classify-batch knob from `config`. |
| `createJevAsk` | Function | Build a jev-ask knob from `config`. |
| `DeadlineExceeded` | Type | The Msg the deadline dispatches when the wall clock crosses `atMs`. |
| `deadlineSub` | Function | Re-export the deadline Sub primitives so consumers (and tests) wire one import: `subscribeDeadline` is the `subscribe` handler, `deadlineSub` builds the Sub literal both composed wrappers' `subs` emit. |
| `DeadlineSub` | Type | The Sub variant a deadline produces. |
| `DEFAULT_CLASSIFY_MAX_ITEMS` | Variable | The default page size — the one the grill settled on for Jev. |
| `DEFAULT_JEV_MODEL` | Variable | The model the door asks for when config names none. |
| `isTransientJevAskErr` | Function | Does this failure deserve another attempt? |
| `ItemAnswer` | Type | The answer one item's question yields. |
| `ItemQuestion` | Type | The one `choice` question an item is asked. |
| `ItemQuestions` | Type | The `questions` map of one batch: one ItemQuestion per item, keyed by `keyOf(item)`. |
| `JEV_ENDPOINT` | Variable | The evaluation endpoint. |
| `JevAnswer` | Type | One typed answer. |
| `JevAnswerFor` | Type | The answer a given question type yields, with the choice union carried through. |
| `JevAnswers` | Type | A questions map turned into its answers map, id for id. |
| `JevAskCmd` | Type | The Cmd the verbs emit — `resilient_run` carrying the request. |
| `jevAskCmdDef` | Function | The one effect this knob emits: run the ask for `key` with the plain-data JevRequest (ADR 0014 — a Cmd is DECLARED, so its input, ok and err channels are types on the constructor rather than a convention). |
| `JevAskConfig` | Interface | The jev-ask knob. |
| `JevAskErr` | Type | Every way an ask can fail, as DATA. |
| `JevAskFailure` | Class | The carrier that gets a JevAskErr out of the port and through resilient-call's throw seam intact. |
| `JevChoiceAnswer` | Interface | The chosen option and the full distribution over the options. |
| `JevChoiceCriteria` | Type | A choice question's rubric: option key → description, or `null` where an option needs no extra detail. |
| `JevChoiceQuestion` | Interface | Pick one option from a set you define. |
| `JevCmd` | Type | The Cmd type a host machine declares in `types.cmd` when it splices a createJevAsk knob in — JevAskCmd under the name a `types` block reads well with. |
| `JevErr` | Type | Every way a response can fail to be the answers to the questions asked. |
| `JevFailMsg` | Type | The failure settle Msg — resilient-call's, with `error` narrowed to JevAskErr. |
| `JevFallback` | Type | The pure decider that answers when the network cannot. |
| `JevHttpStatus` | Type | What a caller does next with an HTTP status. |
| `JevNoulAnswer` | Interface | The yes/no answer, on a scale from 0 (no) to 1 (yes). |
| `JevNoulQuestion` | Interface | A yes/no question. |
| `JevOk` | Interface | The settled answer carried on `resilient_ok`. |
| `JevParse` | Type | What `parseAnswers` returns: typed answers, or one `JevErr`. |
| `JevPort` | Type | The injected HTTP caller — the one seam that touches the network. |
| `JevQuestion` | Type | One typed question. |
| `JevQuestionMap` | Type | The `questions` map: an id you choose → the question asked under it. |
| `jevQuestions` | Function | Identity, with the literal keys kept. |
| `JevQuestionType` | Type | The three question types, as the `type` discriminant spells them. |
| `JevRequest` | Interface | The request body of `POST /v1/systemone`. |
| `JevResponse` | Interface | The response body of `POST /v1/systemone`. |
| `JevScoreAnswer` | Interface | The probability-weighted value across the levels — it can land BETWEEN levels, which is why `score` is a `number` and not an index. |
| `JevScoreCriteria` | Type | A score question's rubric: an ORDERED list of level descriptions, at least two of them. |
| `JevScoreQuestion` | Interface | Rate the state along an ordered rubric. |
| `JevState` | Type | The content to evaluate: text, or structured data. |
| `JevSub` | Type | The Sub type a host machine declares in `types.sub` — the deadline Sub `subs` emits, inherited from resilient-call. |
| `JevSucceedMsg` | Type | The success settle Msg — resilient-call's, with `result` narrowed to JevOk. |
| `JevText` | Type | What every `instructions` and every criterion description accepts. |
| `JevTimerMsg` | Type | The retry / deadline timer Msg — `DeadlineExceeded`, inherited. |
| `JevUsage` | Interface | Token usage for the request. |
| `KeyAnswer` | Type | What ClassifyBatchKnob.answerFor reports about one key. |
| `liftJevAsk` | Function | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.resilience` — resilient-call's convenience, re-typed for this door's slice so a consumer wires one import. |
| `parseAnswers` | Function | Turn an `unknown` response body into the typed answers for `questions`, or into one `JevErr`. |
| `ResilientState` | Interface | The slice. |
| `subscribeDeadline` | Variable | The `subscribe["deadline"]` handler for the DEFAULT `setTimeout` backing. |
