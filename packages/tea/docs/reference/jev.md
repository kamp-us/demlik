# @demlik/tea/jev

> ask TypeSafe **Jev** (System One) a map of typed questions and get a typed answer back under each name: the wire contract, the one Cmd that issues the call, and the batching composition over it.

Tier: `battery`

```ts
import { … } from "@demlik/tea/jev";
```

## Exports (62)

| Symbol | Kind | Tier | Summary |
| --- | --- | --- | --- |
| [`Batch`](#Batch) | Interface | battery | One flushed batch, as plain data: the items and the id fan-out addresses it by. |
| [`ClassifyBatchCmd`](#ClassifyBatchCmd) | Type | battery | The Cmd a flushed batch becomes — `../ask`'s, carrying the native request. |
| [`ClassifyBatchConfig`](#ClassifyBatchConfig) | Interface | battery | The knob. |
| [`ClassifyBatchErrMsg`](#ClassifyBatchErrMsg) | Type | battery | The failure settle Msg — `../ask`'s, with the typed JevAskErr. |
| [`ClassifyBatchKnob`](#ClassifyBatchKnob) | Type | battery | The bound knob createClassifyBatch returns. |
| [`ClassifyBatchOkMsg`](#ClassifyBatchOkMsg) | Type | battery | The success settle Msg — `../ask`'s, with the batch's answers. |
| [`ClassifyBatchState`](#ClassifyBatchState) | Interface | battery | The slice: the three batteries' own slices, plus the one fact none of them holds — which keys a failed batch left unanswered. |
| [`ClassifyCriteria`](#ClassifyCriteria) | Type | battery | The rubric every item is classified against: option key → description, or `null` where an option needs no extra detail. |
| [`classifyStatus`](#classifyStatus) | Function | battery | Classify one HTTP status, per the reference page's error table. |
| [`createClassifyBatch`](#createClassifyBatch) | Function | battery | Build a classify-batch knob from `config`. |
| [`createJevAsk`](#createJevAsk) | Function | battery | Build a jev-ask knob from `config`. |
| [`decodeJevReply`](#decodeJevReply) | Function | battery | Turn an HTTP reply into the run Cmd's outcome. |
| [`DEFAULT_CLASSIFY_MAX_ITEMS`](#DEFAULT_CLASSIFY_MAX_ITEMS) | Variable | battery | The default page size — the one the grill settled on for Jev. |
| [`DEFAULT_JEV_MODEL`](#DEFAULT_JEV_MODEL) | Variable | battery | The model the door asks for when config names none. |
| [`isJevErr`](#isJevErr) | Function | battery | Is `value` a JevErr? |
| [`isTransientJevAskErr`](#isTransientJevAskErr) | Function | battery | Does this failure deserve another attempt? |
| [`ItemAnswer`](#ItemAnswer) | Type | battery | The answer one item's question yields. |
| [`ItemQuestion`](#ItemQuestion) | Type | battery | The one `choice` question an item is asked. |
| [`ItemQuestions`](#ItemQuestions) | Type | battery | The `questions` map of one batch: one ItemQuestion per item, keyed by `keyOf(item)`. |
| [`JEV_ENDPOINT`](#JEV_ENDPOINT) | Variable | battery | The evaluation endpoint. |
| [`JevAnswer`](#JevAnswer) | Type | battery | One typed answer. |
| [`JevAnswerFor`](#JevAnswerFor) | Type | battery | The answer a given question type yields, with the choice union carried through. |
| [`JevAnswers`](#JevAnswers) | Type | battery | A questions map turned into its answers map, id for id. |
| [`JevAskCmd`](#JevAskCmd) | Type | battery | The Cmd the verbs emit — `resilient_run` carrying the request. |
| [`jevAskCmdDef`](#jevAskCmdDef) | Function | battery | The one effect this knob emits: run the ask for `key` with the plain-data JevRequest (ADR 0014 — a Cmd is DECLARED, so its input, ok and err channels are types on the constructor rather than a convention). |
| [`JevAskConfig`](#JevAskConfig) | Interface | battery | The jev-ask knob. |
| [`JevAskErr`](#JevAskErr) | Type | battery | Every way an ask can fail, as DATA. |
| [`jevAskErrOf`](#jevAskErrOf) | Function | battery | Read a settled failure back as a JevAskErr. |
| [`jevCallThrew`](#jevCallThrew) | Function | battery | The outcome for a call that threw before Jev answered — a socket error, a DNS failure. |
| [`JevChoiceAnswer`](#JevChoiceAnswer) | Interface | battery | The chosen option and the full distribution over the options. |
| [`JevChoiceCriteria`](#JevChoiceCriteria) | Type | battery | A choice question's rubric: option key → description, or `null` where an option needs no extra detail. |
| [`JevChoiceQuestion`](#JevChoiceQuestion) | Interface | battery | Pick one option from a set you define. |
| [`JevCmd`](#JevCmd) | Type | battery | The Cmd type a host machine declares in `types.cmd` when it splices a createJevAsk knob in — JevAskCmd under the name a `types` block reads well with. |
| [`JevErr`](#JevErr) | Type | battery | Every way a response can fail to be the answers to the questions asked. |
| [`JevFailMsg`](#JevFailMsg) | Type | battery | The failure settle Msg the engine mints — resilient-call's. |
| [`JevFallback`](#JevFallback) | Type | battery | The pure decider that answers when the network cannot. |
| [`JevHttpReply`](#JevHttpReply) | Interface | battery | What an HTTP call to Jev came back with: the status and the undecoded body. |
| [`JevHttpStatus`](#JevHttpStatus) | Type | battery | What a caller does next with an HTTP status. |
| [`JevNoulAnswer`](#JevNoulAnswer) | Interface | battery | The yes/no answer, on a scale from 0 (no) to 1 (yes). |
| [`JevNoulQuestion`](#JevNoulQuestion) | Interface | battery | A yes/no question. |
| [`JevOk`](#JevOk) | Interface | battery | The settled answer carried on `resilient_run_ok`. |
| [`JevParse`](#JevParse) | Type | battery | What `parseAnswers` returns: typed answers, or one `JevErr`. |
| [`JevQuestion`](#JevQuestion) | Type | battery | One typed question. |
| [`JevQuestionMap`](#JevQuestionMap) | Type | battery | The `questions` map: an id you choose → the question asked under it. |
| [`jevQuestions`](#jevQuestions) | Function | battery | Identity, with the literal keys kept. |
| [`JevQuestionType`](#JevQuestionType) | Type | battery | The three question types, as the `type` discriminant spells them. |
| [`JevRejected`](#JevRejected) | Type | battery | How a JevAskErr crosses the handler: the run Cmd's declared `port_rejected` tag, with the typed error on `jev`. |
| [`JevRequest`](#JevRequest) | Interface | battery | The request body of `POST /v1/systemone`. |
| [`JevResponse`](#JevResponse) | Interface | battery | The response body of `POST /v1/systemone`. |
| [`JevScoreAnswer`](#JevScoreAnswer) | Interface | battery | The probability-weighted value across the levels — it can land BETWEEN levels, which is why `score` is a `number` and not an index. |
| [`JevScoreCriteria`](#JevScoreCriteria) | Type | battery | A score question's rubric: an ORDERED list of level descriptions, at least two of them. |
| [`JevScoreQuestion`](#JevScoreQuestion) | Interface | battery | Rate the state along an ordered rubric. |
| [`JevState`](#JevState) | Type | battery | The content to evaluate: text, or structured data. |
| [`JevSucceedMsg`](#JevSucceedMsg) | Type | battery | The success settle Msg — resilient-call's, with `value` narrowed to JevOk. |
| [`JevText`](#JevText) | Type | battery | What every `instructions` and every criterion description accepts. |
| [`JevTimerMsg`](#JevTimerMsg) | Type | battery | The retry / deadline timer Msg — `DeadlineExceeded`, inherited. |
| [`JevUsage`](#JevUsage) | Interface | battery | Token usage for the request. |
| [`KeyAnswer`](#KeyAnswer) | Type | battery | What ClassifyBatchKnob.answerFor reports about one key. |
| [`liftJevAsk`](#liftJevAsk) | Function | battery | Lift a knob result `[slice, cmds]` into a host `[State, cmds]` where the slice lives at `state.resilience` — resilient-call's convenience, re-typed for this door's slice so a consumer wires one import. |
| [`offlineJevAnswer`](#offlineJevAnswer) | Function | battery | The outcome with no network at all: the fallback's answer, or its refusal, or `no_answer_path` when there is no fallback. |
| [`parseAnswers`](#parseAnswers) | Function | battery | Turn an `unknown` response body into the typed answers for `questions`, or into one `JevErr`. |
| [`ResilientState`](#ResilientState) | Interface | battery | The slice. |

## Declarations

<a id="Batch"></a>

### `Batch`

```ts
interface Batch<I> {
  readonly id: string;
  readonly items: readonly I[];
}
```

<a id="ClassifyBatchCmd"></a>

### `ClassifyBatchCmd`

```ts
type ClassifyBatchCmd<C extends string> = JevAskCmd<ItemQuestions<C>>
```

<a id="ClassifyBatchConfig"></a>

### `ClassifyBatchConfig`

```ts
interface ClassifyBatchConfig<I, C extends string> {
  /** Max batches in flight, forwarded to fan-out. */
  readonly concurrency: number;
  /** The rubric every item is classified against. Its keys are the answer domain. */
  readonly criteria: ClassifyCriteria<C>;
  /** Eviction tick for the TTL cache. Omit and no eviction Sub is declared. */
  readonly evictEveryMs?: number;
  /** The pure decider `offline` answers with, for a handler with no key. */
  readonly fallback?: JevFallback<Readonly<Record<string, ItemQuestion<C>>>>;
  /**
   * The `instructions` for one item's question. Defaults to a template naming
   * the item's key, which is what tells the model WHICH element of the request
   * `state` the question is about.
   */
  readonly instructions?: (key: string, item: I) => JevText;
  /**
   * The cache key and the question id of an item — e.g. a sanitized merchant
   * string, so two transactions at the same shop share one answer. PURE.
   */
  readonly keyOf: (item: I) => string;
  /** Size trigger, forwarded to the batch window. Defaults to DEFAULT_CLASSIFY_MAX_ITEMS. */
  readonly maxItems?: number;
  /** Latency ceiling in ms, forwarded to the batch window. */
  readonly maxMs: number;
  /** The model asked for. Forwarded to `../ask`'s default when omitted. */
  readonly model?: string;
  /** How long a settled answer stays cached, forwarded to the TTL cache. */
  readonly ttlMs: number;
}
```

<a id="ClassifyBatchErrMsg"></a>

### `ClassifyBatchErrMsg`

```ts
type ClassifyBatchErrMsg = JevFailMsg
```

<a id="ClassifyBatchKnob"></a>

### `ClassifyBatchKnob`

```ts
type ClassifyBatchKnob<I, C extends string> = ReturnType<typeof createClassifyBatch>
```

<a id="ClassifyBatchOkMsg"></a>

### `ClassifyBatchOkMsg`

```ts
type ClassifyBatchOkMsg<C extends string> = JevSucceedMsg<ItemQuestions<C>>
```

<a id="ClassifyBatchState"></a>

### `ClassifyBatchState`

```ts
interface ClassifyBatchState<I, C extends string> {
  /** The answers, keyed by `keyOf` — `../../resilience/cache`'s slice. */
  readonly cache: TtlCache<JevChoiceAnswer<Extract<C, string>>>;
  /** Keys whose batch settled `resilient_run_err`, with the error that settled it. */
  readonly failed: Readonly<Record<string, JevAskErr>>;
  /** The in-flight batches — `../../flow/fan-out`'s slice. */
  readonly fanOut: FanOutState<Batch<I>, JevOk<Readonly<Record<string, ItemQuestion<C>>>>>;
  /** The open batch window — `../../flow/batch-window`'s slice. */
  readonly window: BatchWindow<I>;
}
```

<a id="ClassifyCriteria"></a>

### `ClassifyCriteria`

```ts
type ClassifyCriteria<C extends string> = Readonly<Record<C, JevText | null>>
```

<a id="classifyStatus"></a>

### `classifyStatus`

```ts
function classifyStatus(status: number): JevHttpStatus
```

<a id="createClassifyBatch"></a>

### `createClassifyBatch`

```ts
function createClassifyBatch<I, C extends string>(
  config: ClassifyBatchConfig<I, C>,
): {
  /**
   * Offer `item` to the pipeline at `at`. PURE.
   *
   * An item whose key is cached, buffered, or already in a batch is DROPPED:
   * the cache hit is the whole point of the cache, and the other two are what
   * keeps one key out of two batches at once — which is the property that makes
   * a batch's id a usable identity and an answer's key unambiguous.
   *
   * An item that is NOT dropped loses its standing failure mark, exactly as
   * onBatchOk clears one: from the instant the key is buffered it is in
   * flight again, and a `failed` entry left standing would make `answerFor`
   * report the PREVIOUS attempt's error for the whole of the new one — telling a
   * host that polls it to stop waiting for work that is running.
   */
  add: (state: State, item: I, at: number) => readonly [State, Cmds];
  /**
   * What is known about `key` at `at`. PURE, derived — it stores nothing.
   *
   * `at` is a parameter rather than a clock read because a TTL answer is only
   * an answer relative to an instant, and this module reads no clock anywhere.
   * The host passes the `at` of the Msg it is handling.
   *
   * The precedence is ANSWER_ORDER, not this function's statement
   * order; `absent` is what every slice deferring means.
   */
  answerFor: (state: State, key: string, at: number) => KeyAnswer<C>;
  /** The ask Cmd def — list it in the machine's `cmds`. */
  ask: CmdDef<"resilient_run", {
    readonly input: JevRequest;
    readonly key: string;
  }, JevOk<Readonly<Record<string, ItemQuestion<C>>>>, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>;
  /**
   * Your handler's outcome for Jev's reply to one batch — `../ask`'s
   * `decodeJevReply`, parsing against the questions the batch carried.
   */
  decode: (
    request: JevRequest<Readonly<Record<string, ItemQuestion<C>>>>,
    reply: JevHttpReply,
  ) => Outcome<JevOk<Readonly<Record<string, ItemQuestion<C>>>>, JevRejected>;
  /** The starting slice — each battery's own `init`, side by side. */
  init: () => State;
  /** Your handler's outcome with no network — the configured `fallback`. */
  offline: (
    request: JevRequest<Readonly<Record<string, ItemQuestion<C>>>>,
  ) => Outcome<JevOk<Readonly<Record<string, ItemQuestion<C>>>>, JevRejected>;
  /**
   * A batch settled `resilient_run_err`. PURE.
   *
   * Each of its keys is marked failed with the error that settled it and the
   * cache is NOT touched: a failure is not an answer, and writing one back under
   * `ttlMs` would poison every later `add` for that key for the whole TTL. The
   * key stays re-addable, because it is neither cached nor in flight once
   * fan-out has moved the batch to `failed`.
   */
  onBatchErr: (state: State, msg: JevFailMsg) => readonly [State, Cmds];
  /**
   * A batch settled OK. PURE.
   *
   * Every answer is written back to the cache with `ttlMs` at `msg.at`, the
   * batch's keys lose any standing failure mark, and fan-out backfills the freed
   * concurrency slot — so the returned Cmds are the next batches' asks.
   *
   * An answer arrives under the question id it was asked under, which is the
   * item's own key, so the write-back needs no positional matching between the
   * request `state` array and the answers map.
   */
  onBatchOk: (state: State, msg: ClassifyBatchOkMsg<C>) => readonly [State, Cmds];
  /** The eviction tick fired: drop every entry expired at `at`. PURE. */
  onEvict: (state: State, at: number) => readonly [State, Cmds];
  /** The time window closed: flush whatever is buffered. PURE. */
  onWindow: (state: State, at: number) => readonly [State, Cmds];
  /** Your handler's outcome when the call threw — `../ask`'s `jevCallThrew`. */
  rejected: (cause: unknown) => Outcome<never, JevRejected>;
  /**
   * The machine's `subs` entries, over a host Model that holds the slice where
   * `select` reads it: the window's built-in `timer`, plus the cache's eviction
   * tick when `evictEveryMs` is configured.
   */
  subEntries: <Model>(
    select: (model: Model) => State,
    id?: string,
  ) => readonly DepKeyedSub<Model, CacheEvictionSub | TimerSub<BatchWindowExpired>>[];
  /**
   * The window's flush deadline while a window is open. Fan-out lists none (it
   * runs no timers). PURE.
   */
  subs: (state: State, id?: string) => readonly BatchWindowSub[];
  /**
   * The runners the `subEntries` Subs need beyond the built-in `timer`, handed
   * to `run` as `subscribe`: the cache's eviction tick.
   */
  subscribers: () => {
    cache: SubscribeHandler<CacheEvictionSub, CacheEvictMsg, unknown>;
  };
}
```

<a id="createJevAsk"></a>

### `createJevAsk`

```ts
function createJevAsk<Q extends Readonly<Record<string, JevQuestion>>>(
  config: JevAskConfig<Q>,
  rng?: () => number,
): {
  /**
   * Ask the configured questions about `content` under `key`. PURE — it builds
   * the plain-data request (no closures: `state`, `model` and `questions` are
   * all values) and delegates straight to resilient-call's gate.
   */
  attempt: (
    s: State,
    key: string,
    content: JevState,
    at: number,
  ) => readonly [State, readonly JevAskCmd<Q>[]];
  /** The call's deadlines — resilient-call's retry and deadline timers. */
  deadlines: (s: State) => readonly DeadlineSub[];
  /** Your handler's outcome for an HTTP reply — decodeJevReply. */
  decode: (request: JevRequest<Q>, reply: JevHttpReply) => Outcome<JevOk<Q>, JevRejected>;
  /**
   * Record a failure. PURE. The backoff itself is resilient-call's — nothing
   * here recomputes a delay, counts an attempt or reads a clock. What this verb
   * adds is the routing the typed error makes possible, and it is two
   * decisions:
   *
   *   1. A TERMINAL error settles through `settleFailed`, which ends the call
   *      without touching the breaker or the retry counter. Handing a 401 or a
   *      parse failure to `settle` instead would re-issue the identical request
   *      and trip a breaker over a backend that is perfectly healthy.
   *   2. When the transient path EXHAUSTS the retry budget and a `fallback` is
   *      configured, the fallback answers instead of the call settling failed.
   *      This is the one place that can be observed — exhaustion is a fact of
   *      the slice, not of the handler, so the handler cannot know it is on the
   *      last attempt.
   *
   * The slice's `failed` phase stores the typed JevAskErr, never the
   * JevRejected carrier.
   */
  fail: (s: State, msg: JevFailMsg) => readonly [State, readonly JevAskCmd<Q>[]];
  /** The starting slice — resilient-call's. */
  init: () => State;
  name: "resilient";
  /** Your handler's outcome with no network — offlineJevAnswer. */
  offline: (request: JevRequest<Q>) => Outcome<JevOk<Q>, JevRejected>;
  /** A retry / deadline timer fired. PURE — resilient-call's `onTimer`. */
  onTimer: (s: State, msg: JevTimerMsg) => readonly [State, readonly JevAskCmd<Q>[]];
  /** Your handler's outcome when the call threw — jevCallThrew. */
  rejected: (cause: unknown) => Outcome<never, JevRejected>;
  /** The `Cmd.define`d run Cmd — list it in the machine's `cmds`. */
  run: CmdDef<"resilient_run", {
    readonly input: JevRequest;
    readonly key: string;
  }, JevOk<Q>, {
    readonly [detail: string]: unknown;
    readonly _tag: "deadline_exceeded";
  } | {
    readonly [detail: string]: unknown;
    readonly _tag: "port_rejected";
  }>;
  /** Record a settled answer. PURE — resilient-call's `settle`. */
  succeed: (s: State, msg: JevSucceedMsg<Q>) => readonly [State, readonly JevAskCmd<Q>[]];
  /** The built-in `timer` Sub's deps — resilient-call's `timer`. */
  timer: (
    s: ResilientState<JevRequest<Q>, JevOk<Q>>,
  ) => TimerDeps<ResilientTimerMsg<"resilient">> | null;
}
```

<a id="decodeJevReply"></a>

### `decodeJevReply`

```ts
function decodeJevReply<Q extends Readonly<Record<string, JevQuestion>>>(
  request: JevRequest<Q>,
  reply: JevHttpReply,
): Outcome<JevOk<Q>, JevRejected>
```

<a id="DEFAULT_CLASSIFY_MAX_ITEMS"></a>

### `DEFAULT_CLASSIFY_MAX_ITEMS`

```ts
const DEFAULT_CLASSIFY_MAX_ITEMS: 25
```

<a id="DEFAULT_JEV_MODEL"></a>

### `DEFAULT_JEV_MODEL`

```ts
const DEFAULT_JEV_MODEL: "jev-latest"
```

<a id="isJevErr"></a>

### `isJevErr`

```ts
function isJevErr(value: object): value is JevErr
```

<a id="isTransientJevAskErr"></a>

### `isTransientJevAskErr`

```ts
function isTransientJevAskErr(error: JevAskErr): boolean
```

<a id="ItemAnswer"></a>

### `ItemAnswer`

```ts
type ItemAnswer<C extends string> = JevAnswerFor<ItemQuestion<C>>
```

<a id="ItemQuestion"></a>

### `ItemQuestion`

```ts
type ItemQuestion<C extends string> = JevChoiceQuestion<ClassifyCriteria<C>>
```

<a id="ItemQuestions"></a>

### `ItemQuestions`

```ts
type ItemQuestions<C extends string> = Readonly<Record<string, ItemQuestion<C>>>
```

<a id="JEV_ENDPOINT"></a>

### `JEV_ENDPOINT`

```ts
const JEV_ENDPOINT: "https://api.typesafe.ai/v1/systemone"
```

<a id="JevAnswer"></a>

### `JevAnswer`

```ts
type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer
```

<a id="JevAnswerFor"></a>

### `JevAnswerFor`

```ts
type JevAnswerFor<Q> = Q extends {
  readonly criteria: infer C;
  readonly type: "choice";
} ? JevChoiceAnswer<Extract<keyof C, string>> : Q extends { readonly type: "score" } ? JevScoreAnswer : Q extends { readonly type: "noul" } ? JevNoulAnswer : never
```

<a id="JevAnswers"></a>

### `JevAnswers`

```ts
type JevAnswers<Q extends JevQuestionMap> = { readonly [K in keyof Q]: JevAnswerFor<Q[K]> }
```

<a id="JevAskCmd"></a>

### `JevAskCmd`

```ts
type JevAskCmd<Q extends JevQuestionMap> = RunCmd<JevRequest<Q>, "resilient", JevOk<Q>>
```

<a id="jevAskCmdDef"></a>

### `jevAskCmdDef`

```ts
function jevAskCmdDef<Q extends Readonly<Record<string, JevQuestion>>>(): CmdDef<"resilient_run", {
  readonly input: JevRequest;
  readonly key: string;
}, JevOk<Q>, {
  readonly [detail: string]: unknown;
  readonly _tag: "deadline_exceeded";
} | {
  readonly [detail: string]: unknown;
  readonly _tag: "port_rejected";
}>
```

<a id="JevAskConfig"></a>

### `JevAskConfig`

```ts
interface JevAskConfig<Q extends JevQuestionMap> {
  /** The pure decider for the no-key and budget-spent paths. Absent → those settle as an error. */
  readonly fallback?: JevFallback<Q>;
  /** The model id asked for. Defaults to DEFAULT_JEV_MODEL. */
  readonly model?: string;
  /** The question map every request carries; its keys type the answers. */
  readonly questions: Q;
  /** Backoff policy, composed into `../../resilience/resilient-call`. Omit → no backoff. */
  readonly retry?: RetryPolicy;
}
```

<a id="JevAskErr"></a>

### `JevAskErr`

```ts
type JevAskErr =
  | JevErr
  | {
    readonly _tag: "http_retry";
    readonly status: number;
  }
  | {
    readonly _tag: "http_terminal";
    readonly status: number;
  }
  | {
    readonly _tag: "port_threw";
    readonly reason: string;
  }
  | { readonly _tag: "no_answer_path" }
```

<a id="jevAskErrOf"></a>

### `jevAskErrOf`

```ts
function jevAskErrOf(error: unknown): JevAskErr
```

<a id="jevCallThrew"></a>

### `jevCallThrew`

```ts
function jevCallThrew(cause: unknown): Outcome<never, JevRejected>
```

<a id="JevChoiceAnswer"></a>

### `JevChoiceAnswer`

```ts
interface JevChoiceAnswer<K extends string = string> {
  readonly choice: K;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<K, number>>;
  readonly type: "choice";
}
```

<a id="JevChoiceCriteria"></a>

### `JevChoiceCriteria`

```ts
type JevChoiceCriteria = Readonly<Record<string, JevText | null>>
```

<a id="JevChoiceQuestion"></a>

### `JevChoiceQuestion`

```ts
interface JevChoiceQuestion<C extends JevChoiceCriteria = JevChoiceCriteria> {
  readonly criteria: C;
  readonly instructions: JevText;
  readonly type: "choice";
}
```

<a id="JevCmd"></a>

### `JevCmd`

```ts
type JevCmd<Q extends JevQuestionMap> = JevAskCmd<Q>
```

<a id="JevErr"></a>

### `JevErr`

```ts
type JevErr =
  | {
    readonly _tag: "malformed_body";
    readonly reason: string;
  }
  | {
    readonly _tag: "missing_answer";
    readonly id: string;
  }
  | {
    readonly _tag: "answer_type_mismatch";
    readonly expected: JevQuestionType;
    readonly id: string;
    readonly received: string;
  }
  | {
    readonly _tag: "off_criteria_choice";
    readonly choice: string;
    readonly id: string;
    readonly options: readonly string[];
  }
  | {
    readonly _tag: "off_criteria_probabilities";
    readonly extra: readonly string[];
    readonly id: string;
    readonly missing: readonly string[];
    readonly options: readonly string[];
  }
  | {
    readonly _tag: "malformed_answer";
    readonly id: string;
    readonly reason: string;
  }
```

<a id="JevFailMsg"></a>

### `JevFailMsg`

```ts
type JevFailMsg = FailMsg
```

<a id="JevFallback"></a>

### `JevFallback`

```ts
type JevFallback<Q extends JevQuestionMap> = (request: JevRequest<Q>) => JevAnswers<Q> | JevErr
```

<a id="JevHttpReply"></a>

### `JevHttpReply`

```ts
interface JevHttpReply {
  readonly body: unknown;
  readonly status: number;
}
```

<a id="JevHttpStatus"></a>

### `JevHttpStatus`

```ts
type JevHttpStatus = "ok" | "retry" | "terminal"
```

<a id="JevNoulAnswer"></a>

### `JevNoulAnswer`

```ts
interface JevNoulAnswer {
  readonly noul: number;
  readonly type: "noul";
}
```

<a id="JevNoulQuestion"></a>

### `JevNoulQuestion`

```ts
interface JevNoulQuestion {
  readonly criteria?: {
    readonly false: JevText;
    readonly true: JevText;
  };
  readonly instructions: JevText;
  readonly type: "noul";
}
```

<a id="JevOk"></a>

### `JevOk`

```ts
interface JevOk<Q extends JevQuestionMap> {
  /** The typed answers, one per question id. */
  readonly answers: JevAnswers<Q>;
  /** The model that answered, as the response reported it (or the requested one, for a fallback). */
  readonly model: string;
  /** Which path produced this answer. */
  readonly source: "port" | "fallback";
  /** Tokens spent. Zero on the fallback path. */
  readonly usage: JevUsage;
}
```

<a id="JevParse"></a>

### `JevParse`

```ts
type JevParse<Q extends JevQuestionMap> =
  | {
    readonly answers: JevAnswers<Q>;
    readonly model: string;
    readonly ok: true;
    readonly usage: JevUsage;
  }
  | { readonly error: JevErr; readonly ok: false }
```

<a id="JevQuestion"></a>

### `JevQuestion`

```ts
type JevQuestion = JevChoiceQuestion | JevScoreQuestion | JevNoulQuestion
```

<a id="JevQuestionMap"></a>

### `JevQuestionMap`

```ts
type JevQuestionMap = Readonly<Record<string, JevQuestion>>
```

<a id="jevQuestions"></a>

### `jevQuestions`

```ts
function jevQuestions<const Q extends Readonly<Record<string, JevQuestion>>>(
  questions: Q,
): Q
```

<a id="JevQuestionType"></a>

### `JevQuestionType`

```ts
type JevQuestionType = "choice" | "score" | "noul"
```

<a id="JevRejected"></a>

### `JevRejected`

```ts
type JevRejected = {
  readonly _tag: "port_rejected";
  readonly jev: JevAskErr;
}
```

<a id="JevRequest"></a>

### `JevRequest`

```ts
interface JevRequest<Q extends JevQuestionMap = JevQuestionMap> {
  readonly model: string;
  readonly questions: Q;
  readonly state: JevState;
}
```

<a id="JevResponse"></a>

### `JevResponse`

```ts
interface JevResponse<Q extends JevQuestionMap = JevQuestionMap> {
  readonly answers: JevAnswers<Q>;
  readonly model: string;
  readonly usage: JevUsage;
}
```

<a id="JevScoreAnswer"></a>

### `JevScoreAnswer`

```ts
interface JevScoreAnswer {
  readonly confidence: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly score: number;
  readonly type: "score";
}
```

<a id="JevScoreCriteria"></a>

### `JevScoreCriteria`

```ts
type JevScoreCriteria = readonly [JevText, JevText, ...JevText[]]
```

<a id="JevScoreQuestion"></a>

### `JevScoreQuestion`

```ts
interface JevScoreQuestion {
  readonly criteria: JevScoreCriteria;
  readonly instructions: JevText;
  readonly type: "score";
}
```

<a id="JevState"></a>

### `JevState`

```ts
type JevState = string | Readonly<Record<string, unknown>> | readonly unknown[]
```

<a id="JevSucceedMsg"></a>

### `JevSucceedMsg`

```ts
type JevSucceedMsg<Q extends JevQuestionMap> = SucceedMsg<JevOk<Q>>
```

<a id="JevText"></a>

### `JevText`

```ts
type JevText = string | Readonly<Record<string, unknown>> | readonly unknown[]
```

<a id="JevTimerMsg"></a>

### `JevTimerMsg`

```ts
type JevTimerMsg = DeadlineExceeded
```

<a id="JevUsage"></a>

### `JevUsage`

```ts
interface JevUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}
```

<a id="KeyAnswer"></a>

### `KeyAnswer`

```ts
type KeyAnswer<C extends string> =
  | {
    readonly answer: ItemAnswer<C>;
    readonly status: "answered";
  }
  | {
    readonly error: JevAskErr;
    readonly status: "failed";
  }
  | { readonly status: "pending" }
  | { readonly status: "absent" }
```

<a id="liftJevAsk"></a>

### `liftJevAsk`

```ts
function liftJevAsk<
  S extends {
    resilience: ResilientState<JevRequest<Q>, JevOk<Q>>;
  },
  Q extends Readonly<Record<string, JevQuestion>>,
  C extends Cmd,
>(
  state: S,
  result: readonly [ResilientState<JevRequest<Q>, JevOk<Q>>, readonly C[]],
): readonly [S, readonly C[]]
```

<a id="offlineJevAnswer"></a>

### `offlineJevAnswer`

```ts
function offlineJevAnswer<Q extends Readonly<Record<string, JevQuestion>>>(
  request: JevRequest<Q>,
  fallback: JevFallback<Q> | undefined,
): Outcome<JevOk<Q>, JevRejected>
```

<a id="parseAnswers"></a>

### `parseAnswers`

```ts
function parseAnswers<Q extends Readonly<Record<string, JevQuestion>>>(
  questions: Q,
  body: unknown,
): JevParse<Q>
```

<a id="ResilientState"></a>

### `ResilientState`

```ts
interface ResilientState<I, R> {
  readonly bucket: TokenBucket;
  readonly cache: TtlCache<R>;
  readonly calls: Readonly<Record<string, CallPhase<I, R>>>;
  readonly circuit: CircuitState;
  /**
   * The instant of the latest clocked transition this slice saw — the `at` of
   * the last `attempt` / `resume` / `settleFailed`, settled Msg or timer fire.
   * `timer` counts the soonest deadline down from it, so the built-in `timer`
   * Sub gets a relative `ms` without anything reading a clock. `0` until the
   * first clocked transition.
   */
  readonly clockMs: number;
  /**
   * Per-key backoff counter. Entries minted by `backoff` are `TimedRetryState`s
   * (they carry the streak's `firstFailureAtMs`, since every failure path holds
   * the observation instant); the field is typed at the `RetryState` supertype
   * because a key that has never failed has no streak, and a slice persisted
   * before the origin existed rehydrates without one. Still plain data.
   */
  readonly retry: Readonly<Record<string, RetryState>>;
}
```
