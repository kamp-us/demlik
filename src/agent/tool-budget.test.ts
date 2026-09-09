/**
 * #144 — a tool's `timeoutMs` budget is charged in IN-PROCESS elapsed time, and
 * the budget is read before an attempt is dispatched, not after it returns.
 *
 * The bug these assertions pin was one stamp: the ladder persisted the deadline
 * as an absolute instant on the host's wall clock, so a budget kept running
 * while no process existed. Two things fell out of that, and both are tested
 * here:
 *
 *   - Downtime was CHARGED. A tool with a 2s budget, evicted for 3s, came back
 *     already out of time — a timeout on the host's absence, not on the tool.
 *   - The check ran too late. The resumed ladder re-issued the attempt, made a
 *     real handler call with a real side effect, and only then settled `timeout`
 *     and threw the result away. Under DO eviction that was once per laddered
 *     tool per wake.
 *
 * The kill/resume boundary is crossed the way the durability contract defines
 * it: the Model is JSON round-tripped, the machine is rebuilt from nothing, and
 * `boot` is called at a far later instant. Handler invocations are counted as
 * the tool Cmds the reducer emits — the reducer never calls a handler itself, it
 * dispatches, so one emitted Cmd IS one handler call.
 */

import { describe, expect, it } from "vitest";
import type { RetryPolicy } from "../retry-backoff";
import {
  type AgentTurn,
  createAgent,
  type Schema,
  type ToolCall,
  type ToolResilience,
} from "./index";

type Stage = "act";
type Purpose = "act_turn";
interface Outputs extends Record<Purpose, unknown> {
  readonly act_turn: AgentTurn;
}

/** The budget under test. Every instant below is chosen against this number. */
const TIMEOUT_MS = 2_000;

/**
 * A 3-attempt ladder whose backoff is 500ms flat and unjittered, so the elapsed
 * arithmetic in each test is arithmetic and not a range.
 */
const LADDER: RetryPolicy = {
  baseMs: 500,
  factor: 1,
  capMs: 500,
  jitter: "none",
  maxAttempts: 3,
};

type ToolCmd = { readonly type: "run_tool" } & ToolCall;
const toolOf = (call: ToolCall): ToolCmd => ({ type: "run_tool", ...call });

const turnSchema: Schema<AgentTurn> = { parse: (v) => v as AgentTurn };

/** The tool the tests call, and its policy — `timeoutMs`, with or without a ladder. */
const CALL: ToolCall = { callId: "c1", name: "slow", args: {} };
const asksForTool: AgentTurn = { content: "working", toolCalls: [CALL] };

function makeAgent(policy: ToolResilience) {
  return createAgent<Stage, Purpose, Outputs, string, ToolCmd, never>({
    stages: ["act"],
    // The model is never invoked: every test drives the reducer by hand.
    model: () => ({
      withStructuredOutput: <T>() => ({ invoke: async () => ({}) as T }),
    }),
    schemas: { act_turn: turnSchema },
    turnOf: () => "act_turn",
    toolOf,
    toolResilienceOf: () => policy,
    rng: () => 0,
  });
}

/**
 * The kill: everything the process knew, reduced to what a `Store` actually
 * keeps. A field that does not survive this is not durable state, so a budget
 * that reads correctly only on the near side of it has not been fixed.
 */
function killed<S>(s: S): S {
  return JSON.parse(JSON.stringify(s)) as S;
}

/** Every tool Cmd in a batch — one per handler call the reducer authorized. */
function toolCmds(cmds: readonly unknown[]): ToolCmd[] {
  return cmds.filter((c): c is ToolCmd => (c as ToolCmd).type === "run_tool");
}

/** The Model shape every verb below folds. */
type AgentModel = ReturnType<ReturnType<typeof makeAgent>["init"]>;

/**
 * The outcome the conversation recorded for `CALL` — what the model will be
 * shown — or `null` while the call is still running. The batch drains into the
 * conversation, so this is where a ladder-authored ending lands.
 */
function outcomeOf(s: AgentModel): unknown {
  for (const record of s.conversation?.toolRecords ?? []) {
    if (record.call.callId === CALL.callId) return record.outcome;
  }
  return null;
}

/**
 * Drive a run to the point the bug reproduces from: the tool has been launched,
 * one attempt has failed, and the ladder is parked in backoff owing the next
 * attempt to its retry timer. Returns the state at that instant.
 */
function parkedInBackoff(
  agent: ReturnType<typeof makeAgent>,
  failedAt: number,
) {
  let [s] = agent.start(agent.init(), "r", 0);
  [s] = agent.turn(s, asksForTool, 0);
  [s] = agent.toolErr(s, CALL.callId, "upstream", failedAt);
  return s;
}

describe("tool timeoutMs — the budget is in-process elapsed, not wall-clock position", () => {
  it("does not charge downtime: a resume with budget left re-attempts", () => {
    // 200ms of the 2s budget is spent in-process, then the process is gone for
    // an hour. Under the old absolute stamp the deadline was long past on the
    // way back and the call was dead on arrival; charged in elapsed time, 1.8s
    // of budget is still there and the tool gets the attempt it is owed.
    const agent = makeAgent({ timeoutMs: TIMEOUT_MS, retry: LADDER });
    const parked = killed(parkedInBackoff(agent, 200));
    const wake = 200 + 3_600_000;

    const [booted] = agent.boot(parked, wake);
    // The retry timer is past due, so it fires at the wake instant.
    const [after, cmds] = agent.onTimer(booted, {
      type: "deadline_exceeded",
      id: `resilient:retry:$tool:${CALL.name}#${CALL.callId}`,
      atMs: wake,
    });

    expect(toolCmds(cmds)).toEqual([toolOf(CALL)]);
    expect(outcomeOf(after)).toBeNull(); // still running — nothing settled
  });

  it("settles timeout on resume without one further handler call when the budget was already spent", () => {
    // The in-process half alone spends the budget: the attempt fails 2.5s after
    // the call started, which is past the 2s cap. Then the process dies and
    // stays dead far longer than anything that is left. The resume must end the
    // call — and must not buy the attempt whose result it would discard.
    const agent = makeAgent({ timeoutMs: TIMEOUT_MS, retry: LADDER });
    const parked = killed(parkedInBackoff(agent, 2_500));
    const wake = 2_500 + 3_600_000;

    const [booted, bootCmds] = agent.boot(parked, wake);
    const [after, timerCmds] = agent.onTimer(booted, {
      type: "deadline_exceeded",
      id: `resilient:retry:$tool:${CALL.name}#${CALL.callId}`,
      atMs: wake,
    });

    // ZERO further handler calls across the kill/resume boundary — the count
    // that made this a bug worth filing rather than a mis-timed timeout.
    expect(toolCmds(bootCmds)).toEqual([]);
    expect(toolCmds(timerCmds)).toEqual([]);
    expect(outcomeOf(after)).toEqual({
      _tag: "timeout",
      kind: "error",
      reason: "timeout",
    });
  });

  it("re-arms a resumed call's timeout from the wake, for what is left of the budget", () => {
    // A call killed mid-ATTEMPT is the path `boot` re-issues. The Sub it arms is
    // where "downtime is not charged" becomes visible: the deadline is the wake
    // plus the REMAINING budget, so a tool evicted for an hour with 2s left gets
    // 2s of attention — where the absolute stamp armed a timer already in the
    // past and fired it on the next tick.
    const agent = makeAgent({ timeoutMs: TIMEOUT_MS });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, asksForTool, 0);
    const wake = 3_600_000;

    const [booted, cmds] = agent.boot(killed(s), wake);
    // Idempotent re-issue (the consumer's tool runner dedupes on `callId`), and
    // nothing settled — the budget was never spent, only the host was away.
    expect(toolCmds(cmds)).toEqual([toolOf(CALL)]);
    expect(outcomeOf(booted)).toBeNull();

    const deadline = agent
      .subs(booted)
      .find((sub) => sub.id.startsWith("resilient:deadline:$tool:"));
    expect(deadline?.atMs).toBe(wake + TIMEOUT_MS);
  });

  it("shares one budget across a live ladder: attempt N+1 gets no refresh", () => {
    // The in-process meaning that must NOT regress. Two failures 900ms apart
    // under a 2s cap leave 200ms, and the deadline Sub the ladder arms says so:
    // a refreshed budget would arm 2s out from the latest attempt instead.
    const agent = makeAgent({ timeoutMs: TIMEOUT_MS, retry: LADDER });
    let [s] = agent.start(agent.init(), "r", 0);
    [s] = agent.turn(s, asksForTool, 0);
    [s] = agent.toolErr(s, CALL.callId, "upstream", 900);
    [s] = agent.onTimer(s, {
      type: "deadline_exceeded",
      id: `resilient:retry:$tool:${CALL.name}#${CALL.callId}`,
      atMs: 1_400,
    });
    [s] = agent.toolErr(s, CALL.callId, "upstream", 1_800);

    const deadline = agent
      .subs(s)
      .find((sub) => sub.id.startsWith("resilient:deadline:$tool:"));
    // 2_000ms from the call's start at 0 — not 2_000 from the last attempt.
    expect(deadline?.atMs).toBe(TIMEOUT_MS);
  });
});
