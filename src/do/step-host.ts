/// <reference types="@cloudflare/workers-types" />
/**
 * @demlik/tea/do — `stepHost`, the HTTP-PULL control carrier (#92).
 *
 * ## Carrier selection — pick by WHO INITIATES the message
 *
 * `stepHost` is a SIBLING to {@link acceptCommandSocket}, never a replacement.
 * Both carriers commonly run together in ONE Durable Object; choose between
 * them per *plane*, by who sends the next message:
 *
 *   - **Pull (this file — `stepHost` over `/step`)** — the CONTROL plane. One
 *     driver (the hands) initiates every message: it asks for the next tool,
 *     runs it, posts the result, asks again. There is exactly one outstanding
 *     question at a time and the DO is COLD between steps — nothing is owed
 *     while no request is in flight. Hibernation is the resting state, not a
 *     failure: each POST wakes the DO, advances the run one step from its
 *     durable checkpoint, and lets it hibernate again.
 *   - **Push (`acceptCommandSocket` / `sseHub` — WS + SSE)** — the VIEW /
 *     fan-out plane. The DO initiates UNSOLICITED messages: broadcast a frame
 *     to every connected client, stream a live dashboard, push an event no
 *     client asked for. A long-lived socket is the right carrier because the
 *     sender is the DO, not a polling client.
 *
 * The rule in one line: **pull when the client drives a cold-between-steps
 * control loop; push when the DO drives unsolicited fan-out.** A hibernating
 * agent whose only traffic is "run the next tool" wants pull — that is the case
 * a production consumer adopted this carrier for.
 *
 * ## Why pull is hibernation-correct
 *
 * The WS push carrier keeps a socket open across steps; if the DO evicts, the
 * socket dies (or, with #91's `acceptDurableCommandSocket`, survives but still
 * holds an in-flight round-trip the heap forgot). The pull carrier holds NO
 * cross-step state in the heap. Every `/step` POST is a FRESH request that:
 *
 *   1. **validates** the per-run capability token (constant-time compare),
 *   2. **re-arms** the eviction-safe give-up alarm via `ctx.storage.setAlarm`
 *      (the DO-native alarm API — the `do_alarm` Sub was dropped, see the
 *      `host.ts` header; the alarm is a host concern, not a machine Sub),
 *   3. **settles** the posted tool result IDEMPOTENTLY through
 *      `idempotent-intake` — a re-POSTed result is absorbed exactly once and
 *      the duplicate replays the same next step,
 *   4. **resumes** the run from its durable checkpoint (the #68 event-sourced
 *      store / #91 in-flight ledger) by dispatching the settle and running to
 *      DISPATCH-QUIESCENCE,
 *   5. **returns** the next step (the next tool call) — or the terminal output
 *      read off `runtime.result()` — and lets the DO HIBERNATE.
 *
 * No warm loop is held between responses. The durable checkpoint IS the loop's
 * continuation; the heap is disposable.
 *
 * ## It is ASSEMBLY over bricks tea already ships
 *
 *   - `idempotent-intake` (`createIntake`) — the dedupe-by-key receive-once
 *     settle. The posted result's `callId` is the idempotency key, so a
 *     re-POST lands as a duplicate and replays the cached decision.
 *   - `poller` primitives (`retry-backoff`) — the hands-side {@link runStepLoop}
 *     pull loop: absolute deadline + backoff + dedupe-by-callId.
 *   - the #68/#91 durable checkpoint — read by the consumer's `resume` callback
 *     (it dispatches the settle into the runtime, whose `doEventSourcedStore`
 *     rebuilt state from the log on this cold wake).
 *
 * This file owns NONE of those primitives — it wires them into the `/step`
 * request/response contract and the token lifecycle.
 */

import { createIntake } from "../idempotent-intake/index";
import {
  defaultRetryPolicy,
  initRetry,
  nextDelayMs,
  type RetryPolicy,
  type Rng,
  recordFailure,
  shouldRetry,
} from "../retry-backoff/index";

// ─────────────────────────────────────────────────────────────────────────────
// The `/step` request/response envelope (#92.1).
//
// The control plane's wire contract. A request carries the capability token,
// the runId, and the RESULT of the previously-returned step (null on the first
// request, before any step has been handed out). A response carries the NEXT
// step — the next tool call to execute — or a terminal `{ done, output }`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tool result the hands POST back for the step they just executed. `callId`
 * matches the step the previous response handed out (it is BOTH the correlation
 * id and the idempotency key — a re-POST carries the same `callId` and is
 * absorbed once). `result` is the opaque tool output `R`.
 */
export interface StepResult<R> {
  readonly callId: string;
  readonly result: R;
}

/**
 * A `/step` request. `token` is the per-run capability (validated
 * constant-time). `runId` names the run. `posted` is the result of the
 * previously-returned step, or `null` on the FIRST request (no step has been
 * handed out yet, so there is nothing to settle).
 */
export interface StepRequest<R> {
  readonly token: string;
  readonly runId: string;
  readonly posted: StepResult<R> | null;
}

/**
 * The next tool call to execute — the "continue" arm of a `/step` response.
 * `callId` is the correlation/idempotency id the hands echo back in the next
 * request's `posted`. `tool` + `input` describe the call (opaque to the host).
 */
export interface NextStep<I> {
  readonly callId: string;
  readonly tool: string;
  readonly input: I;
}

/**
 * A `/step` response — a discriminated union on `done`:
 *   - `{ done: false, step }` — execute `step`, POST its result, ask again.
 *   - `{ done: true, output }` — the run is terminal; `output` is its result.
 *
 * This is the ORIGINAL 2-arm INLINE contract, kept byte-identical: a host that
 * resolves each step inside the held request returns exactly these two shapes.
 * The not-ready arm ({@link StepWorking}) is a SEPARATE, opt-in type reachable
 * only through the defer-resume hook — see {@link DeferredStepResponse}. Keeping
 * `StepResponse` a strict subset is what makes inline adopters unaffected: their
 * `if (r.done) … else r.step` narrowing never sees a third member.
 */
export type StepResponse<I, O> =
  | { readonly done: false; readonly step: NextStep<I> }
  | { readonly done: true; readonly output: O };

/**
 * The NOT-READY arm — the run is computing OUT-OF-BAND under a defer-resume host
 * (a production incident: a non-blocking pull carrier must
 * answer a pull with an explicit "computing, poll again" instead of holding the
 * request across a multi-second step). The held `/step` request returns this
 * IMMEDIATELY instead of inline-awaiting `engine.resume`; the hands re-poll
 * (optionally after `retryAfterMs`) until the deferred compute lands in the
 * durable checkpoint and a real {@link StepResponse} step/done arm is returned.
 *
 * It is a first-class discriminated member (`working: true`), NOT a hollow
 * `{ done: false }` with an absent/stale `step` — the not-ready state is made
 * representable so it can never be confused with a real pending step.
 */
export interface StepWorking {
  readonly done: false;
  readonly working: true;
  /**
   * Advisory earliest re-poll delay as a hint to the hands (ms to wait before
   * the next pull). Purely advisory — a host may omit it and the hands fall back
   * to their own backoff curve.
   */
  readonly retryAfterMs?: number;
}

/**
 * The 3-arm response a DEFER-RESUME host returns — the inline {@link StepResponse}
 * arms PLUS {@link StepWorking}. A superset of `StepResponse`, so a 2-arm value is
 * assignable to it (the widening is safe for existing transports); discriminate
 * with `if (r.done)` for terminal, then `"working" in r` for the not-ready arm,
 * else the step arm.
 */
export type DeferredStepResponse<I, O> = StepResponse<I, O> | StepWorking;

// ─────────────────────────────────────────────────────────────────────────────
// Capability token (#92.3) — a per-run bearer secret, constant-time compared.
//
// NOT OAuth: `token-refresh` is OAuth-shaped (access/refresh pairs, expiry,
// rotation) and the WRONG tool here. A `/step` token is a single random secret
// minted once per run and persisted in DO storage; every `/step` POST for that
// run must present it. The compare is constant-time so a caller cannot probe
// the secret byte-by-byte via response timing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint a fresh per-run capability token: 32 random bytes, hex-encoded. Uses the
 * Web Crypto `crypto.getRandomValues` available in the Workers runtime (and in
 * Node's test runtime via the global `crypto`). Persist the returned string in
 * DO storage keyed by runId; hand the SAME string to the hands once, at run
 * start.
 */
export function mintRunToken(
  randomBytes: (n: number) => Uint8Array = defaultRandomBytes,
): string {
  const bytes = randomBytes(32);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function defaultRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/**
 * Constant-time string equality. Returns `true` iff `a` and `b` are
 * byte-for-byte equal, in time that depends ONLY on `a.length` — never on WHERE
 * the first mismatch is. A length mismatch still returns `false`, but the
 * comparison loop always runs `a.length` iterations against a same-length view,
 * so the early-exit timing oracle a naive `===` leaks is closed.
 *
 * The XOR-accumulate idiom: fold every position's difference into one
 * accumulator and test it once at the end. No `break`, no short-circuit.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  // Length is not secret (it is bounded + fixed by `mintRunToken`), so folding
  // it into the verdict up front is safe; the loop below still runs a fixed
  // number of iterations for a given `a`, leaking no position information.
  const lengthMatches = a.length === b.length;
  // Compare against `a` itself when lengths differ, so the loop body does the
  // same work every call and the mismatch is carried solely by `lengthMatches`.
  const rhs = lengthMatches ? b : a;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ rhs.charCodeAt(i);
  }
  return diff === 0 && lengthMatches;
}

// ─────────────────────────────────────────────────────────────────────────────
// stepHost (#92.2) — the `/step` handler.
//
// The host-layer assembly. The consumer supplies a `StepEngine<R, I, O>` — the
// run-specific operations the handler orchestrates (token lookup, settle into
// the runtime, resume to quiescence, read next step / terminal). `stepHost`
// owns the ORDER (validate → setAlarm → idempotent-settle → resume → return →
// hibernate), the idempotency, and the HTTP status mapping; the engine owns the
// run-specific I/O. This is the same dependency-injection shape as
// `durableCommandCarrier` (hooks) and `createAgentHost` (mappings).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The DO-native alarm slice `stepHost` re-arms. A real `DurableObjectStorage`
 * satisfies this structurally; a test supplies a fake (no live Workers runtime).
 * Only `setAlarm` is needed — the give-up deadline is re-armed on every step so
 * a run abandoned mid-loop (the hands stop POSTing) is eventually evicted by the
 * alarm firing, not left resident forever.
 */
export interface AlarmStorage {
  setAlarm(scheduledTime: number): void | Promise<void>;
}

/** The minimal `ctx` slice `stepHost` reads — just the alarm-bearing storage. */
export interface StepCtx {
  readonly storage: AlarmStorage;
}

/**
 * The run-specific operations `stepHost` orchestrates. The consumer implements
 * these against its runtime + storage; `stepHost` never reaches into the agent
 * machine itself (that lives in `../agent`, off-limits to this carrier).
 */
export interface StepEngine<R, I, O> {
  /**
   * The persisted capability token for `runId`, or `null` if the run is
   * unknown. Read from DO storage. `stepHost` compares the request token
   * against this constant-time.
   */
  tokenFor(runId: string): Promise<string | null> | string | null;
  /**
   * Settle the posted tool result into the run, then RESUME from the durable
   * checkpoint: dispatch the settle and run to DISPATCH-QUIESCENCE (e.g.
   * `await runtime.dispatch(settleMsg)` — dispatch drains the follow-up chain
   * by default, #50). Called at most once per distinct
   * `callId` — `stepHost` dedupes re-POSTs via `idempotent-intake` BEFORE
   * calling this, so the side effect runs exactly once. On the first request
   * (`posted === null`) `stepHost` skips settle and calls {@link nextStep}
   * directly to hand out the first step.
   */
  resume(runId: string, posted: StepResult<R>): Promise<void> | void;
  /**
   * Read the next step the run is now waiting on — the next tool call — off the
   * resumed runtime's durable state, or `null` if the run has reached its
   * terminal State (then {@link terminalOutput} supplies the output).
   */
  nextStep(runId: string): Promise<NextStep<I> | null> | NextStep<I> | null;
  /**
   * Read the run's terminal output (off `runtime.result()`). Only called when
   * {@link nextStep} returned `null`.
   */
  terminalOutput(runId: string): Promise<O> | O;
}

/** Tuning for `stepHost`'s give-up alarm. */
export interface StepHostConfig {
  /**
   * How far ahead, in ms, to re-arm the give-up alarm on every step. A run that
   * stops POSTing for longer than this is abandoned and the alarm fires (the
   * consumer's `alarm()` handler tears the run down). Defaults to 5 minutes.
   */
  readonly giveUpAfterMs?: number;
}

/**
 * The DEFER-RESUME hook — the opt-in seam that drives `engine.resume` OUT of the
 * held `/step` request. A non-blocking host (a non-blocking production audit carrier)
 * cannot inline-await a multi-second step inside the held request, so instead of
 * `stepHost` calling `engine.resume` inline it hands the posted result to this
 * hook to SETTLE-AND-ENQUEUE (record it durably, schedule the compute in a
 * returning activation) and returns the {@link StepWorking} arm PROMPTLY. A later
 * pull re-reads the durable next-step once {@link DeferResumeHook.settled} reports
 * the enqueued compute has landed.
 *
 * Providing this hook is what flips `stepHost` from the 2-arm inline contract to
 * the 3-arm deferred contract — see the `stepHost` overloads. Omit it and the
 * host stays byte-identical inline.
 */
export interface DeferResumeHook<R> {
  /**
   * SETTLE-AND-ENQUEUE the posted result to resume OUT of the held request:
   * durably record it and schedule the compute (e.g. `ctx.storage.setAlarm` or a
   * queue) so a returning activation runs `engine.resume`. MUST return promptly —
   * it never awaits the step compute. Called at most once per distinct `callId`
   * (`stepHost` dedupes re-POSTs through `idempotent-intake` first), so a re-POST
   * of the same step does not re-enqueue.
   */
  enqueue(runId: string, posted: StepResult<R>): void | Promise<void>;
  /**
   * Has the enqueued resume for `callId` COMPLETED and been written to the
   * durable checkpoint? `false` ⇒ the held request returns {@link StepWorking}
   * (poll again); `true` ⇒ `stepHost` reads the next step / terminal output off
   * the now-advanced checkpoint, exactly as the inline path does.
   */
  settled(runId: string, callId: string): boolean | Promise<boolean>;
  /**
   * Optional advisory re-poll delay (ms) surfaced on the {@link StepWorking} arm
   * so the hands can back off to the host's expected step latency.
   */
  readonly retryAfterMs?: number;
}

/**
 * `StepHostConfig` with the defer-resume hook engaged — the presence of
 * `deferResume` is the type-level switch that selects the 3-arm response (see the
 * `stepHost` overloads). Extends the inline config, so the alarm tuning is shared.
 */
export interface DeferStepHostConfig<R> extends StepHostConfig {
  readonly deferResume: DeferResumeHook<R>;
}

/**
 * A structured `/step` outcome `stepHost` returns — the response body plus the
 * HTTP status the consumer's route should send. Kept transport-agnostic (no
 * `Response`) so the same handler is unit-testable without a live `fetch`.
 */
export type StepOutcome<I, O> =
  | { readonly status: 200; readonly body: StepResponse<I, O> }
  | { readonly status: 401 | 404; readonly body: { readonly error: string } };

/**
 * The `/step` outcome a DEFER-RESUME host returns — like {@link StepOutcome} but
 * its 200 body is the 3-arm {@link DeferredStepResponse} (it can carry the
 * not-ready arm). Returned only from the `deferResume` overload of `stepHost`;
 * the inline overload keeps the narrower {@link StepOutcome}.
 */
export type DeferredStepOutcome<I, O> =
  | { readonly status: 200; readonly body: DeferredStepResponse<I, O> }
  | { readonly status: 401 | 404; readonly body: { readonly error: string } };

const DEFAULT_GIVE_UP_MS = 5 * 60_000;

/**
 * Build the {@link StepWorking} arm, attaching `retryAfterMs` only when the host
 * supplied one — so the wire body stays minimal (`{ done, working }`) unless a
 * re-poll hint is offered.
 */
function workingBody(retryAfterMs?: number): StepWorking {
  return retryAfterMs === undefined
    ? { done: false, working: true }
    : { done: false, working: true, retryAfterMs };
}

/**
 * Build the `/step` handler for a DO that drives one or more runs over the pull
 * carrier. Returns `handle(request, now)` — call it from the DO's `/step`
 * route, map the `StepOutcome` to a `Response`, and let the DO hibernate.
 *
 * The handler is STATELESS between calls except for its `idempotent-intake`
 * dedupe ledger, which the consumer should itself persist alongside the run's
 * checkpoint if cross-eviction dedupe of an identical re-POST is required; the
 * in-isolate ledger here dedupes re-POSTs within one activation (the common
 * "the hands' POST timed out and got retried" case), and the underlying
 * `resume` is itself idempotent against the durable checkpoint, so a re-POST
 * that crosses an eviction re-settles harmlessly.
 *
 * @param ctx    the DO state slice (alarm-bearing storage)
 * @param engine the run-specific operations
 * @param config alarm tuning
 */
// Overloads (specific → general): a config carrying `deferResume` selects the
// 3-arm deferred handler; every other call — no config, or alarm-only config —
// keeps the 2-arm inline handler, byte-and-type-identical to before this change.
export function stepHost<R, I, O>(
  ctx: StepCtx,
  engine: StepEngine<R, I, O>,
  config: DeferStepHostConfig<R>,
): {
  handle(
    request: StepRequest<R>,
    now: number,
  ): Promise<DeferredStepOutcome<I, O>>;
};
export function stepHost<R, I, O>(
  ctx: StepCtx,
  engine: StepEngine<R, I, O>,
  config?: StepHostConfig,
): {
  handle(request: StepRequest<R>, now: number): Promise<StepOutcome<I, O>>;
};
export function stepHost<R, I, O>(
  ctx: StepCtx,
  engine: StepEngine<R, I, O>,
  config: StepHostConfig | DeferStepHostConfig<R> = {},
): {
  handle(
    request: StepRequest<R>,
    now: number,
  ): Promise<DeferredStepOutcome<I, O>>;
} {
  const giveUpAfterMs = config.giveUpAfterMs ?? DEFAULT_GIVE_UP_MS;
  // The opt-in defer-resume hook. Present ⇒ resume runs OUT of the held request
  // and a not-ready pull returns the working arm; absent ⇒ the inline path below
  // runs unchanged. `"deferResume" in config` is the runtime switch matching the
  // type-level overload split.
  const deferResume: DeferResumeHook<R> | null =
    "deferResume" in config ? config.deferResume : null;

  // The receive-once settle ledger. Key = the posted result's `callId`, so a
  // re-POST of the SAME step lands as a duplicate and replays the cached
  // decision instead of re-settling. `R = "settled"` — the cached value is just
  // a marker that this callId's settle already happened; the actual next step is
  // re-read off the (idempotent) durable checkpoint either way.
  const intake = createIntake<StepResult<R>, "settled">({
    keyOf: (posted) => posted.callId,
  });
  // The intake slice lives in the isolate for this activation. It is a plain
  // serializable value (the consumer MAY persist `intakeState` next to its
  // checkpoint for cross-eviction dedupe); within one activation it absorbs the
  // duplicate POST so `resume` fires at most once per callId here.
  let intakeState = intake.init();

  async function handle(
    request: StepRequest<R>,
    now: number,
  ): Promise<DeferredStepOutcome<I, O>> {
    // 1 — VALIDATE the capability token (constant-time). A missing run is 404;
    //     a present run with a wrong/missing token is 401. The constant-time
    //     compare runs regardless of whether the stored token exists (compare
    //     against the empty string) so the 401 path leaks no timing.
    const stored = await engine.tokenFor(request.runId);
    if (stored === null) {
      return { status: 404, body: { error: "unknown run" } };
    }
    if (!constantTimeEqual(request.token, stored)) {
      return { status: 401, body: { error: "invalid token" } };
    }

    // 2 — RE-ARM the eviction-safe give-up alarm via the DO-native alarm API.
    //     Every step pushes the deadline out; a run that stops POSTing is
    //     eventually evicted when the alarm fires. (The `do_alarm` Sub was
    //     dropped — see the `host.ts` header — so this is a direct storage call,
    //     not a machine Sub.)
    await ctx.storage.setAlarm(now + giveUpAfterMs);

    // 3 — SETTLE the posted result (skip on the first request, where there is
    //     nothing to settle). Two shapes, chosen by whether the defer-resume
    //     hook is engaged:
    const posted = request.posted;
    if (posted !== null) {
      if (deferResume === null) {
        // INLINE (default, unchanged) — settle + resume idempotently INSIDE the
        // held request. `intake.receive` decides new-vs-duplicate and emits the
        // decision as a Cmd; a genuinely-new callId runs `resume` exactly once, a
        // duplicate replays (no re-settle). Either way step 4 re-reads the next
        // step off the durable checkpoint, so a duplicate POST returns the SAME
        // next step.
        const [nextIntake, cmds] = intake.receive(
          intakeState,
          posted,
          now,
          posted.callId,
        );
        intakeState = nextIntake;
        for (const cmd of cmds) {
          if (cmd.type === "intake:process") {
            await engine.resume(request.runId, posted);
            const [completed] = intake.complete(
              intakeState,
              cmd.key,
              "settled",
              now,
            );
            intakeState = completed;
          }
          // `intake:replay` (a duplicate) needs no action: `resume` already ran
          // for this callId, and step 4 re-derives the next step below.
        }
      } else {
        // DEFER (opt-in) — resume runs OUT of the held request. Readiness is the
        // gate: if the enqueued resume has already landed in the durable
        // checkpoint, fall through to step 4 and read the next step (identical to
        // the inline tail). If not, (idempotently) enqueue the resume to run in a
        // returning activation and return the WORKING arm — the held request
        // never awaits the step compute (the same production incident). The
        // per-callId enqueue is idempotent host-side, so re-POSTs across cold
        // wakes do not re-enqueue; the in-isolate `intake` ledger is not used on
        // this path because it cannot survive the eviction between pulls.
        const ready = await deferResume.settled(request.runId, posted.callId);
        if (!ready) {
          await deferResume.enqueue(request.runId, posted);
          return { status: 200, body: workingBody(deferResume.retryAfterMs) };
        }
      }
    }

    // 4 — RETURN the next step, or the terminal output. Read off the resumed
    //     run's durable state — NOT off any warm loop. The DO hibernates after
    //     this response; the checkpoint is the continuation.
    const next = await engine.nextStep(request.runId);
    if (next === null) {
      const output = await engine.terminalOutput(request.runId);
      return { status: 200, body: { done: true, output } };
    }
    return { status: 200, body: { done: false, step: next } };
  }

  return { handle };
}

// ─────────────────────────────────────────────────────────────────────────────
// runStepLoop (#92.4) — the hands-side pull loop over `/step`.
//
// The thin client the HANDS run: POST `/step` → get the next tool → execute it
// (consumer callback) → POST the result → repeat until terminal. Built on the
// `poller` primitives (`retry-backoff`) — absolute deadline + backoff + dedupe
// by callId — exactly the loop the poller knob composes internally, lifted to a
// standalone async driver (the hands are not a TEA machine; they drive one).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `/step` transport the hands POST through (injected; faked in tests).
 * Returns the 3-arm {@link DeferredStepResponse} — a defer-resume host may answer
 * with the not-ready arm, which {@link runStepLoop} re-polls. An inline host's
 * 2-arm transport (`=> Promise<StepResponse>`) is assignable here (the narrower
 * return widens), so existing inline adopters are unaffected.
 */
export type StepTransport<R, I, O> = (
  request: StepRequest<R>,
) => Promise<DeferredStepResponse<I, O>>;

/** Execute one tool call and produce its result (the consumer's hands). */
export type ExecuteStep<I, R> = (step: NextStep<I>) => Promise<R> | R;

/** Tuning for {@link runStepLoop}. */
export interface RunStepLoopConfig {
  /**
   * Absolute wall-clock deadline (ms epoch). The loop stops asking once `now()`
   * reaches it, surfacing a `deadline_exceeded` outcome. Mirrors the poller's
   * absolute-deadline contract (a resumed loop honors the SAME moment).
   */
  readonly deadlineMs: number;
  /** Backoff policy for FAILED `/step` POSTs. Defaults to `defaultRetryPolicy`. */
  readonly retry?: RetryPolicy;
  /** Clock, injected for determinism. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** `(ms) => Promise` sleep, injected for determinism. Defaults to real sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Backoff jitter RNG, injected for determinism. Defaults to `Math.random`. */
  readonly rng?: Rng;
}

/** The terminal outcome of a full {@link runStepLoop} drive. */
export type StepLoopOutcome<O> =
  | { readonly kind: "done"; readonly output: O }
  | { readonly kind: "deadline_exceeded" }
  | { readonly kind: "gave_up"; readonly error: unknown };

/**
 * Drive the pull loop to completion. Starting from `{ posted: null }`, POST
 * `/step`, and for each non-terminal response execute the step and POST its
 * result, until the response is terminal (`done: true`) — then return its
 * output.
 *
 * Resilience composed from `poller`'s primitives:
 *   - **absolute deadline** — `config.deadlineMs`. Before each POST the loop
 *     checks `now() >= deadlineMs` and stops with `deadline_exceeded` rather
 *     than asking forever.
 *   - **backoff** — a FAILED POST (transport reject) is retried on the
 *     `retry-backoff` curve; once `shouldRetry` is exhausted the loop stops
 *     with `gave_up`. A success resets the retry counter.
 *   - **dedupe** — a step whose `callId` was already executed in THIS drive is
 *     not re-executed; its prior result is re-POSTed. Closes the "the host
 *     re-handed the same step after a duplicate settle" path (the host side is
 *     idempotent; the hands match it).
 *   - **not-ready re-poll** — a {@link StepWorking} arm (a defer-resume host
 *     computing the step out-of-band) is not a step: the loop re-POSTs the SAME
 *     `posted` after a backoff (honoring the host's advisory `retryAfterMs`),
 *     until a real step / done arrives. Bounded only by the absolute deadline —
 *     an inline host never returns this arm, so its drive is unchanged.
 */
export async function runStepLoop<R, I, O>(
  token: string,
  runId: string,
  transport: StepTransport<R, I, O>,
  execute: ExecuteStep<I, R>,
  config: RunStepLoopConfig,
): Promise<StepLoopOutcome<O>> {
  const policy = config.retry ?? defaultRetryPolicy;
  const now = config.now ?? Date.now;
  const sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rng = config.rng;

  // Dedupe-by-callId for THIS drive: the result already produced for a callId,
  // so a re-handed step re-POSTs the cached result instead of re-executing.
  const executed = new Map<string, R>();
  // The result to POST on the NEXT request (null on the first request).
  let posted: StepResult<R> | null = null;
  // Consecutive not-ready ("working") polls, driving the re-poll backoff curve.
  // Reset on any real step / terminal response. Bounded by the absolute deadline,
  // NOT by `maxAttempts` — a host may legitimately compute for many polls.
  let pollRetry = initRetry();

  for (;;) {
    if (now() >= config.deadlineMs) return { kind: "deadline_exceeded" };

    // POST `/step` with backoff on transport failure.
    let response: DeferredStepResponse<I, O>;
    let retry = initRetry();
    for (;;) {
      try {
        response = await transport({ token, runId, posted });
        break;
      } catch (error) {
        retry = recordFailure(retry, error);
        if (!shouldRetry(retry, policy)) return { kind: "gave_up", error };
        if (now() >= config.deadlineMs) return { kind: "deadline_exceeded" };
        await sleep(nextDelayMs(retry, policy, rng));
      }
    }

    if (response.done) return { kind: "done", output: response.output };

    // NOT-READY arm — a defer-resume host is computing the step OUT-OF-BAND. Do
    // NOT execute anything: re-poll with the SAME `posted` (idempotent re-POST)
    // after a backoff, until the host yields a real step / done. Honor the host's
    // advisory `retryAfterMs` when present, else fall back to the poll backoff
    // curve. The absolute deadline is the only terminal bound here.
    if ("working" in response) {
      pollRetry = recordFailure(pollRetry, "working");
      if (now() >= config.deadlineMs) return { kind: "deadline_exceeded" };
      await sleep(response.retryAfterMs ?? nextDelayMs(pollRetry, policy, rng));
      continue;
    }
    pollRetry = initRetry(); // a real step resets the poll backoff

    // Execute the next step (dedupe: a callId already run in this drive re-POSTs
    // its cached result rather than executing twice).
    const step = response.step;
    const cached = executed.get(step.callId);
    const result = cached !== undefined ? cached : await execute(step);
    if (cached === undefined) executed.set(step.callId, result);
    posted = { callId: step.callId, result };
  }
}
