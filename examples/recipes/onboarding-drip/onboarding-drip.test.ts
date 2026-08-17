import { describe, expect, it } from "vitest";
import { run } from "../../../src/index";
import { type Cell, cell, collect, memStore } from "../harness";
import {
  type Cmd,
  DRIP,
  type Msg,
  onboardingDripMachine,
  parseState,
  type State,
  stepDueAt,
  unsent,
} from "./machine";

const USER = "u_881";
const CMD_TYPES = ["send_email"] as const;

async function boot(c: Cell) {
  const sink = collect<Msg, Cmd, Record<string, never>>(CMD_TYPES);
  const rt = await run(onboardingDripMachine(sink.interpret), {
    ctx: {},
    store: memStore<State>(c, parseState),
  }).ready;
  return { rt, cmds: sink.cmds };
}

type Rt = Awaited<ReturnType<typeof boot>>["rt"];

async function fireDue(rt: Rt) {
  const due = rt.getState().dueAt;
  expect(due).not.toBeNull();
  await rt.dispatch({ type: "tick", at: due as number });
}

describe("onboarding drip — walking the schedule", () => {
  it("sends day 1 / 3 / 7 and completes", async () => {
    const c = cell();
    const { rt, cmds } = await boot(c);

    await rt.dispatch({ type: "enrolled", userId: USER, at: 0 });
    expect(rt.getState().dueAt).toBe(DRIP[0]?.offsetMs);

    for (const step of DRIP) {
      expect(rt.getState().dueAt).toBe(step.offsetMs);
      await fireDue(rt);
    }

    const done = rt.getState();
    expect(done.phase).toBe("completed");
    expect(done.endedBy).toBe("finished");
    expect(done.dueAt).toBeNull();
    expect(cmds.map((cmd) => cmd.template)).toEqual(
      DRIP.map((step) => step.template),
    );
    expect(unsent(done)).toEqual([]);

    await rt.stop();
  });

  it("cancels the rest of the drip when the user becomes active", async () => {
    const c = cell();
    const { rt, cmds } = await boot(c);

    await rt.dispatch({ type: "enrolled", userId: USER, at: 0 });
    await fireDue(rt); // welcome goes out on day 1

    await rt.dispatch({
      type: "user_active",
      what: "created their first project",
      at: 2 * 86_400_000,
    });

    const done = rt.getState();
    expect(done.phase).toBe("completed");
    expect(done.endedBy).toBe("activity");
    expect(done.cancelledBy?.what).toBe("created their first project");
    // Cancellation is a null, not a queue scan.
    expect(done.dueAt).toBeNull();
    expect(unsent(done)).toEqual(["first-tip", "check-in"]);

    // A stale alarm that slipped through sends nothing.
    await rt.dispatch({ type: "tick", at: 7 * 86_400_000 });
    expect(cmds).toHaveLength(1);

    await rt.stop();
  });

  it("derives every send deadline from enrollment alone", () => {
    expect(stepDueAt(500, 0)).toBe(
      500 + (DRIP[0] as { offsetMs: number }).offsetMs,
    );
    expect(stepDueAt(500, DRIP.length)).toBeNull();
  });
});

describe("onboarding drip — resume from serialized state", () => {
  it("resumes between sends and finishes the remaining schedule", async () => {
    const c = cell();
    const first = await boot(c);
    await first.rt.dispatch({ type: "enrolled", userId: USER, at: 0 });
    await fireDue(first.rt);
    expect(first.cmds.map((cmd) => cmd.template)).toEqual(["welcome"]);
    await first.rt.stop();

    const parsed = parseState(JSON.parse(c.raw as string));
    expect(parsed?.cursor).toBe(1);

    const second = await boot(c);
    const resumed = second.rt.getState();
    expect(resumed.phase).toBe("scheduled");
    expect(resumed.sent.map((s) => s.template)).toEqual(["welcome"]);
    // The next deadline is still day 3 from the ORIGINAL enrollment — the
    // restart did not restart the clock.
    expect(resumed.dueAt).toBe(DRIP[1]?.offsetMs);

    await fireDue(second.rt);
    await fireDue(second.rt);
    expect(second.rt.getState().phase).toBe("completed");
    // The fresh runtime only sent what was still owed.
    expect(second.cmds.map((cmd) => cmd.template)).toEqual([
      "first-tip",
      "check-in",
    ]);

    await second.rt.stop();
  });

  it("resumes into a cancelled drip and stays cancelled", async () => {
    const c = cell();
    const first = await boot(c);
    await first.rt.dispatch({ type: "enrolled", userId: USER, at: 0 });
    await first.rt.dispatch({
      type: "user_active",
      what: "invited a teammate",
      at: 100,
    });
    await first.rt.stop();

    const second = await boot(c);
    expect(second.rt.getState().endedBy).toBe("activity");
    await second.rt.dispatch({ type: "tick", at: 7 * 86_400_000 });
    expect(second.cmds).toHaveLength(0);

    await second.rt.stop();
  });
});
