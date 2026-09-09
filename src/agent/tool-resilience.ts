/**
 * @demlik/tea/agent — the per-tool timeout / retry ladder (#117).
 *
 * A `tool()` declares `timeoutMs` and/or `retry`; this module is what runs them.
 * It is the agent's third `resilient-call` composition, beside the brain slice
 * and the dedicated `$compact` one, and it exists for the same reason those do:
 * the ladder has to be DATA on the Model, not control flow inside the handler.
 * A backoff loop written inside the effect boundary is lost to a process kill
 * mid-ladder — which is exactly the durability `@demlik/tea` exists to provide,
 * so the appliance may not ask a user to give it up to get a retry.
 *
 * ## One slice per tool NAME, one key per CALL
 *
 * `createResilientCall` closes over ONE config, and the policy here is declared
 * per tool — so there is one instance, and one slice, per tool name. Within a
 * name, each in-flight call gets its own key ({@link toolCallKey}), so two
 * concurrent calls to the same tool climb independent ladders under one policy.
 * The name rides INSIDE the key because the timer Subs the family arms are keyed
 * `resilient:retry:{key}` / `resilient:deadline:{key}`: the key is the only
 * thing a fired timer carries, so it must be enough to find the slice again.
 *
 * ## What it does not touch
 *
 * A tool declaring neither field mints no slice entry and takes the plain
 * fan-out launch/settle path unchanged — the "omit a brick, skip its gate" rule
 * the resilience family already holds, lifted to the tool set.
 */

import {
  createResilientCall,
  type DeadlineExceeded,
  type DeadlineSub,
  type ResilientState,
  type RunCmd,
} from "../internal/resilience/resilient-call";
import { MsgType } from "../protocol";
import {
  TOOL_RETRY_EXHAUSTED_TAG,
  TOOL_TIMEOUT_TAG,
  type ToolCall,
  type ToolResilience,
} from "./types";

/**
 * The prefix every tool ladder key carries. It namespaces tool keys away from
 * the brain slice's purpose keys and the compaction slice's `$compact`, so a
 * fired timer routes by id with no ambiguity — the same convention `$compact`
 * already uses, one level down.
 */
const TOOL_KEY_PREFIX = "$tool:";

/** The separator between the tool's name and the call's id inside a key. */
const NAME_CALL_SEP = "#";

/**
 * The ladder key for one in-flight call: the tool's name and the model's
 * `callId`, both recoverable from the key a fired timer carries. PURE.
 */
export function toolCallKey(name: string, callId: string): string {
  return `${TOOL_KEY_PREFIX}${name}${NAME_CALL_SEP}${callId}`;
}

/** The tool name and callId a {@link toolCallKey} was built from, or `null`. PURE. */
function readToolCallKey(
  key: string,
): { readonly name: string; readonly callId: string } | null {
  if (!key.startsWith(TOOL_KEY_PREFIX)) return null;
  const body = key.slice(TOOL_KEY_PREFIX.length);
  const at = body.indexOf(NAME_CALL_SEP);
  if (at <= 0) return null;
  return { name: body.slice(0, at), callId: body.slice(at + 1) };
}

/**
 * Whether a fired timer's Sub id belongs to a tool ladder — the routing test
 * the agent's `onTimer` uses to pick this slice over the brain / compaction
 * ones. PURE.
 */
export function isToolTimerId(id: string): boolean {
  return keyOfTimerId(id) !== null;
}

/** The ladder key a `resilient:*` Sub id was minted for, or `null`. PURE. */
function keyOfTimerId(id: string): string | null {
  for (const prefix of ["resilient:retry:", "resilient:deadline:"]) {
    if (id.startsWith(prefix)) {
      const key = id.slice(prefix.length);
      return key.startsWith(TOOL_KEY_PREFIX) ? key : null;
    }
  }
  return null;
}

/** The per-tool-name slice map the agent Model carries. */
export type ToolResilienceState = Readonly<
  Record<string, ResilientState<ToolCall, null>>
>;

/** A call the ladder has decided is over — settle it into the fan-out with `reason`. */
export interface ToolSettleOrder {
  readonly callId: string;
  readonly reason: string;
}

/** What a timer fire produced: launches to re-issue, and calls the ladder gave up on. */
export interface ToolTimerOutcome<TC> {
  readonly cmds: readonly TC[];
  readonly settle: readonly ToolSettleOrder[];
}

/**
 * The ladder as the agent's reducer uses it — every verb PURE, `at` the only
 * clock, and every return a `[slice, …]` tuple the caller folds onto the Model.
 */
export interface ToolLadder<TC> {
  /** The starting slice: no tool has laddered yet. */
  readonly init: () => ToolResilienceState;
  /**
   * Launch `calls`: each one either through its tool's resilient gate (which
   * arms the timeout and emits the run Cmd) or, for a tool with no policy,
   * straight through `toolOf` as it always was.
   */
  readonly launch: (
    s: ToolResilienceState,
    calls: readonly ToolCall[],
    at: number,
  ) => readonly [ToolResilienceState, readonly TC[]];
  /**
   * Record a settled-OK call: drop its ladder bookkeeping so the timeout Sub
   * disarms and the tool's next call starts a fresh ladder.
   */
  readonly ok: (
    s: ToolResilienceState,
    call: ToolCall,
    at: number,
  ) => ToolResilienceState;
  /**
   * Record a failed attempt. The second element is `null` when the ladder
   * ABSORBED the failure — another attempt is armed, the fan-out must not see
   * it — and the reason to settle with when the call is over.
   */
  readonly err: (
    s: ToolResilienceState,
    call: ToolCall,
    reason: string,
    at: number,
  ) => readonly [ToolResilienceState, string | null];
  /** A tool ladder's timer fired: re-issue the next attempt, or give the call up. */
  readonly onTimer: (
    s: ToolResilienceState,
    msg: DeadlineExceeded,
  ) => readonly [ToolResilienceState, ToolTimerOutcome<TC>];
  /** Re-issue the in-flight attempts a cold boot found — see the note on the body. */
  readonly boot: (
    s: ToolResilienceState,
    calls: readonly ToolCall[],
    at: number,
  ) => readonly [ToolResilienceState, readonly TC[]];
  /** Every armed retry / timeout timer across every tool's ladder. */
  readonly subs: (s: ToolResilienceState) => readonly DeadlineSub[];
}

/**
 * Build the ladder for one agent from its two config seams: how a call maps to
 * a policy (`resilienceOf`) and how it maps to the effect Cmd (`toolOf`).
 *
 * `rng` is the determinism seam for the backoff jitter, the same one the brain
 * slice takes; it is read only at the family's verb boundary.
 */
export function createToolLadder<TC>(
  resilienceOf: (call: ToolCall) => ToolResilience | null,
  toolOf: (call: ToolCall) => TC,
  rng: (() => number) | undefined,
): ToolLadder<TC> {
  // One `resilient-call` per tool name, memoized on the name. This is
  // config-derived construction, not state: the instance closes over the tool's
  // declared policy and nothing else, so the same name always yields the same
  // verbs and a replay reproduces them exactly.
  const instances = new Map<
    string,
    ReturnType<typeof createResilientCall<ToolCall, null>>
  >();

  /** The resilient-call for `call`'s tool, or `null` when it declared no policy. */
  function rcFor(call: ToolCall) {
    const policy = resilienceOf(call);
    if (policy === null) return null;
    if (policy.timeoutMs === undefined && policy.retry === undefined) {
      return null;
    }
    const cached = instances.get(call.name);
    if (cached !== undefined) return cached;
    const made = createResilientCall<ToolCall, null>(
      {
        ...(policy.retry !== undefined ? { retry: policy.retry } : {}),
        ...(policy.timeoutMs !== undefined
          ? { deadline: { ms: policy.timeoutMs } }
          : {}),
      },
      rng,
    );
    instances.set(call.name, made);
    return made;
  }

  /** This tool's slice, defaulting to a fresh one — also the rehydration guard. */
  function sliceOf(
    s: ToolResilienceState,
    name: string,
    rc: ReturnType<typeof createResilientCall<ToolCall, null>>,
  ): ResilientState<ToolCall, null> {
    return s[name] ?? rc.init();
  }

  /** Re-key the family's `resilient_run` carriers to the consumer's tool Cmds. */
  function toLaunchCmds(runCmds: readonly RunCmd<ToolCall>[]): readonly TC[] {
    return runCmds.map((cmd) => toolOf(cmd.input));
  }

  const launch: ToolLadder<TC>["launch"] = (s, calls, at) => {
    let next = s;
    const cmds: TC[] = [];
    for (const call of calls) {
      const rc = rcFor(call);
      if (rc === null) {
        cmds.push(toolOf(call));
        continue;
      }
      const [slice, runCmds] = rc.attempt(
        sliceOf(next, call.name, rc),
        toolCallKey(call.name, call.callId),
        call,
        at,
      );
      next = { ...next, [call.name]: slice };
      cmds.push(...toLaunchCmds(runCmds));
    }
    return [next, cmds];
  };

  const ok: ToolLadder<TC>["ok"] = (s, call, at) => {
    const rc = rcFor(call);
    if (rc === null) return s;
    const key = toolCallKey(call.name, call.callId);
    // `succeed` closes the ladder for this key: it drops `retry[key]` and moves
    // the phase to `succeeded`, which is what disarms the timeout Sub. The
    // result arm is `null` on purpose — the tool's VALUE travels through the
    // fan-out ledger, and duplicating it here would put one fact in two places
    // on the durable Model.
    const [slice] = rc.succeed(sliceOf(s, call.name, rc), key, {
      type: MsgType.ResilientOk,
      key,
      result: null,
      at,
    });
    return { ...s, [call.name]: forget(slice, key) };
  };

  const err: ToolLadder<TC>["err"] = (s, call, reason, at) => {
    const rc = rcFor(call);
    if (rc === null) return [s, reason];
    const key = toolCallKey(call.name, call.callId);
    const before = sliceOf(s, call.name, rc);
    // `fail` records the attempt and consults the policy: it either arms the
    // next one (`waiting_retry`, with the retry timer in `subs`) or settles the
    // key `failed`. Both outcomes are Model writes — nothing is retried inside
    // an effect, which is the whole point of routing through here.
    const [slice] = rc.fail(before, key, {
      type: MsgType.ResilientErr,
      key,
      error: reason,
      at,
    });
    if (slice.calls[key]?.phase === "waiting_retry") {
      // Absorbed: the fan-out entry stays `running` and the conversation learns
      // nothing, so the model never sees an attempt the ladder is still working.
      return [{ ...s, [call.name]: slice }, null];
    }
    // Over. With a retry policy the call spent its budget and says so, carrying
    // the attempt count and the last attempt's own reason so the model reads the
    // real failure rather than only the bookkeeping. With no retry policy
    // (a `timeoutMs`-only tool) the first failure IS the outcome, unchanged.
    const attempts = before.retry[key]?.attempt;
    const settled =
      resilienceOf(call)?.retry === undefined
        ? reason
        : exhaustedReason((attempts ?? 0) + 1, reason);
    return [{ ...s, [call.name]: forget(slice, key) }, settled];
  };

  const onTimer: ToolLadder<TC>["onTimer"] = (s, msg) => {
    const key = keyOfTimerId(msg.id);
    const parsed = key === null ? null : readToolCallKey(key);
    if (key === null || parsed === null) return [s, { cmds: [], settle: [] }];
    const slice = s[parsed.name];
    if (slice === undefined) return [s, { cmds: [], settle: [] }];
    // The instance is rebuilt from the call the ladder remembers, so a timer
    // that fires after a reload runs under the tool's declared policy without
    // the slice having to carry the policy itself.
    const remembered = inputOf(slice, key);
    const rc = remembered === null ? null : rcFor(remembered);
    if (rc === null) return [s, { cmds: [], settle: [] }];
    const [next, runCmds] = rc.onTimer(slice, msg);
    const phase = next.calls[key];
    // The deadline arm settles `failed` with the family's plain-data sentinel,
    // whatever the attempt in flight is doing — so the CALL ends on time even
    // though nothing here can end the promise. The attempt's late settle then
    // arrives for a callId the fan-out no longer has running and folds nothing.
    if (phase?.phase === "failed" && isDeadline(phase.error)) {
      return [
        { ...s, [parsed.name]: forget(next, key) },
        {
          cmds: [],
          settle: [{ callId: parsed.callId, reason: TOOL_TIMEOUT_TAG }],
        },
      ];
    }
    return [
      { ...s, [parsed.name]: next },
      { cmds: toLaunchCmds(runCmds), settle: [] },
    ];
  };

  const boot: ToolLadder<TC>["boot"] = (s, calls, at) => {
    let next = s;
    const cmds: TC[] = [];
    for (const call of calls) {
      const rc = rcFor(call);
      if (rc === null) {
        cmds.push(toolOf(call));
        continue;
      }
      const key = toolCallKey(call.name, call.callId);
      const phase = sliceOf(next, call.name, rc).calls[key]?.phase;
      // A call the kill caught BETWEEN attempts is not re-issued: its next
      // attempt is already owed to the retry timer, which `subs` re-arms off the
      // rehydrated slice. Re-issuing here would run an extra handler call the
      // ladder never authorized and reset nothing — the resume would silently
      // buy an attempt the budget did not have.
      if (phase === "waiting_retry") continue;
      const [slice, runCmds] = rc.attempt(
        sliceOf(next, call.name, rc),
        key,
        call,
        at,
      );
      next = { ...next, [call.name]: slice };
      cmds.push(...toLaunchCmds(runCmds));
    }
    return [next, cmds];
  };

  const subs: ToolLadder<TC>["subs"] = (s) => {
    const out: DeadlineSub[] = [];
    for (const slice of Object.values(s)) {
      // Every key in one name's slice shares that tool's policy, so any live
      // call rebuilds the instance whose `subs` knows which timers to arm. No
      // live call → nothing to arm, and nothing to rebuild it from.
      const sample = firstInput(slice);
      const rc = sample === null ? null : rcFor(sample);
      if (rc !== null) out.push(...rc.subs(slice));
    }
    return out;
  };

  return { init: () => ({}), launch, ok, err, onTimer, boot, subs };
}

/**
 * Drop a settled key's entry entirely rather than leaving it `succeeded` /
 * `failed` on the Model. The fan-out ledger and the conversation already carry
 * the outcome; a per-call entry that outlived its call would grow the durable
 * slice once per tool call for the whole run. PURE.
 */
function forget(
  s: ResilientState<ToolCall, null>,
  key: string,
): ResilientState<ToolCall, null> {
  const { [key]: _settled, ...calls } = s.calls;
  const { [key]: _spent, ...retry } = s.retry;
  return { ...s, calls, retry };
}

/** The `ToolCall` a key's live phase remembers, or `null`. PURE. */
function inputOf(
  s: ResilientState<ToolCall, null>,
  key: string,
): ToolCall | null {
  const call = s.calls[key];
  if (call === undefined) return null;
  return call.phase === "running" || call.phase === "waiting_retry"
    ? call.input
    : null;
}

/** Any live call in a slice — enough to rebuild the tool's instance. PURE. */
function firstInput(s: ResilientState<ToolCall, null>): ToolCall | null {
  for (const key of Object.keys(s.calls)) {
    const input = inputOf(s, key);
    if (input !== null) return input;
  }
  return null;
}

/** Whether a settled error is the family's deadline sentinel. PURE. */
function isDeadline(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { _tag?: unknown })._tag === "deadline_exceeded"
  );
}

/**
 * The reason a spent ladder settles under: the tag, the attempts it burned, and
 * the last attempt's own reason — so the model reads the actual failure and not
 * only the fact that a budget ran out. PURE.
 */
function exhaustedReason(attempts: number, last: string): string {
  return `${TOOL_RETRY_EXHAUSTED_TAG} ${JSON.stringify({ attempts, last })}`;
}
