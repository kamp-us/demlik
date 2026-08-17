import { describe, expect, it } from "vitest";
import { run } from "../../../src/index";
import { type Cell, cell, collect, memStore } from "../harness";
import {
  approvalChainMachine,
  type Cmd,
  chaseDueAt,
  ESCALATE_AFTER_MS,
  type Msg,
  parseState,
  REMIND_AFTER_MS,
  type State,
} from "./machine";

const REQ = "exp-2026-114";
const CHAIN = ["lead", "director", "cfo"] as const;
const CMD_TYPES = ["notify_approver", "escalate"] as const;

async function boot(c: Cell) {
  const sink = collect<Msg, Cmd, Record<string, never>>(CMD_TYPES);
  const rt = await run(approvalChainMachine(sink.interpret), {
    ctx: {},
    store: memStore<State>(c, parseState),
  }).ready;
  return { rt, cmds: sink.cmds };
}

type Rt = Awaited<ReturnType<typeof boot>>["rt"];

async function submit(rt: Rt, at = 0) {
  await rt.dispatch({
    type: "submit",
    requestId: REQ,
    amountCents: 184_000,
    approvers: [...CHAIN],
    at,
  });
}

describe("approval chain — the ordered walk", () => {
  it("walks every approver in order and approves on the last yes", async () => {
    const c = cell();
    const { rt, cmds } = await boot(c);
    await submit(rt);

    for (const [n, approver] of CHAIN.entries()) {
      expect(rt.getState().phase).toBe("pending");
      expect(rt.getState().cursor).toBe(n);
      expect(cmds.at(-1)).toEqual({
        type: "notify_approver",
        requestId: REQ,
        approver,
        reason: "assigned",
      });
      await rt.dispatch({
        type: "decide",
        approver,
        verdict: "approved",
        at: (n + 1) * 1_000,
      });
    }

    const done = rt.getState();
    expect(done.phase).toBe("approved");
    expect(done.dueAt).toBeNull();
    // The audit log IS the state: three decisions, each with its own timestamp.
    expect(done.decisions.map((d) => d.approver)).toEqual([...CHAIN]);
    expect(done.decisions.map((d) => d.at)).toEqual([1_000, 2_000, 3_000]);

    await rt.stop();
  });

  it("rejects on the first no and stops chasing", async () => {
    const c = cell();
    const { rt } = await boot(c);
    await submit(rt);
    await rt.dispatch({
      type: "decide",
      approver: "lead",
      verdict: "approved",
      at: 10,
    });
    await rt.dispatch({
      type: "decide",
      approver: "director",
      verdict: "rejected",
      comment: "no budget line for this",
      at: 20,
    });

    const state = rt.getState();
    expect(state.phase).toBe("rejected");
    expect(state.dueAt).toBeNull();
    expect(state.decisions.at(-1)?.comment).toBe("no budget line for this");
    // The cfo was never assigned.
    expect(state.notices.filter((n) => n.approver === "cfo")).toHaveLength(0);

    await rt.stop();
  });

  it("ignores an out-of-order decision rather than forging the log", async () => {
    const c = cell();
    const { rt } = await boot(c);
    await submit(rt);
    await rt.dispatch({
      type: "decide",
      approver: "cfo",
      verdict: "approved",
      at: 10,
    });

    expect(rt.getState().cursor).toBe(0);
    expect(rt.getState().decisions).toHaveLength(0);

    await rt.stop();
  });

  it("reminds after 2 days, escalates after 7, then stops", async () => {
    const c = cell();
    const { rt, cmds } = await boot(c);
    await submit(rt);

    expect(rt.getState().dueAt).toBe(REMIND_AFTER_MS);
    await rt.dispatch({ type: "tick", at: REMIND_AFTER_MS });
    expect(rt.getState().remindedAt).toBe(REMIND_AFTER_MS);
    expect(cmds.at(-1)).toEqual({
      type: "notify_approver",
      requestId: REQ,
      approver: "lead",
      reason: "reminder",
    });

    // The second deadline is still measured from the ASSIGNMENT, not the reminder.
    expect(rt.getState().dueAt).toBe(ESCALATE_AFTER_MS);
    await rt.dispatch({ type: "tick", at: ESCALATE_AFTER_MS });
    expect(cmds.at(-1)).toEqual({
      type: "escalate",
      requestId: REQ,
      stalledOn: "lead",
    });

    // Nothing further is owed — a human has it now.
    expect(rt.getState().dueAt).toBeNull();
    await rt.dispatch({ type: "tick", at: 99 * ESCALATE_AFTER_MS });
    expect(
      rt.getState().notices.filter((n) => n.kind === "escalated"),
    ).toHaveLength(1);

    // The chase resets when the ball moves on.
    await rt.dispatch({
      type: "decide",
      approver: "lead",
      verdict: "approved",
      at: ESCALATE_AFTER_MS + 1,
    });
    expect(rt.getState().remindedAt).toBeNull();
    expect(rt.getState().dueAt).toBe(ESCALATE_AFTER_MS + 1 + REMIND_AFTER_MS);

    await rt.stop();
  });

  it("derives the chase deadline from the assignment alone", () => {
    expect(chaseDueAt(100, null, null)).toBe(100 + REMIND_AFTER_MS);
    expect(chaseDueAt(100, 500, null)).toBe(100 + ESCALATE_AFTER_MS);
    expect(chaseDueAt(100, 500, 900)).toBeNull();
  });
});

describe("approval chain — resume from serialized state", () => {
  it("resumes mid-chain with the audit log intact and finishes", async () => {
    const c = cell();
    const first = await boot(c);
    await submit(first.rt);
    await first.rt.dispatch({
      type: "decide",
      approver: "lead",
      verdict: "approved",
      at: 5_000,
    });
    await first.rt.dispatch({ type: "tick", at: 5_000 + REMIND_AFTER_MS });
    await first.rt.stop();

    const parsed = parseState(JSON.parse(c.raw as string));
    expect(parsed?.cursor).toBe(1);
    expect(parsed?.decisions).toHaveLength(1);

    const second = await boot(c);
    const resumed = second.rt.getState();
    expect(resumed.phase).toBe("pending");
    expect(resumed.approvers[resumed.cursor]).toBe("director");
    expect(resumed.remindedAt).toBe(5_000 + REMIND_AFTER_MS);
    expect(resumed.notices.map((n) => n.kind)).toEqual([
      "assigned",
      "assigned",
      "reminded",
    ]);

    // The escalation deadline survived the restart and still fires on time.
    await second.rt.dispatch({ type: "tick", at: 5_000 + ESCALATE_AFTER_MS });
    expect(second.cmds.at(-1)).toEqual({
      type: "escalate",
      requestId: REQ,
      stalledOn: "director",
    });

    await second.rt.dispatch({
      type: "decide",
      approver: "director",
      verdict: "approved",
      at: 8 * 86_400_000,
    });
    await second.rt.dispatch({
      type: "decide",
      approver: "cfo",
      verdict: "approved",
      at: 9 * 86_400_000,
    });
    expect(second.rt.getState().phase).toBe("approved");
    expect(second.rt.getState().decisions).toHaveLength(3);

    await second.rt.stop();
  });
});
