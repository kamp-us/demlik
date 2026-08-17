import { describe, expect, it } from "vitest";
import { run } from "../../../src/index";
import { type Cell, cell, collect, memStore } from "../harness";
import {
  type Cmd,
  dunningMachine,
  GRACE_MS,
  isTerminal,
  type Msg,
  parseState,
  RETRY_OFFSETS_MS,
  retryDueAt,
  type State,
} from "./machine";

const SUB = "sub_42";
const AMOUNT = 2900;
const CMD_TYPES = ["charge", "notify", "downgrade"] as const;

async function boot(c: Cell) {
  const sink = collect<Msg, Cmd, Record<string, never>>(CMD_TYPES);
  const rt = await run(dunningMachine(sink.interpret), {
    ctx: {},
    store: memStore<State>(c, parseState),
  }).ready;
  return { rt, cmds: sink.cmds };
}

type Rt = Awaited<ReturnType<typeof boot>>["rt"];

/** Fire the alarm the host would have armed for `dueAt`. */
async function fireDue(rt: Rt) {
  const due = rt.getState().dueAt;
  expect(due).not.toBeNull();
  await rt.dispatch({ type: "tick", at: due as number });
}

describe("dunning — the ladder is arithmetic, not a schedule", () => {
  it("retries on day 1 / 3 / 7 then opens a 14-day grace window", async () => {
    const c = cell();
    const { rt, cmds } = await boot(c);

    await rt.dispatch({
      type: "renewal_declined",
      subscriptionId: SUB,
      amountCents: AMOUNT,
      reason: "insufficient_funds",
      at: 0,
    });

    // Every deadline in the whole 21-day process is derivable from one anchor.
    expect(rt.getState().phase).toBe("retrying");
    expect(rt.getState().dueAt).toBe(RETRY_OFFSETS_MS[0]);

    for (const [n, offset] of RETRY_OFFSETS_MS.entries()) {
      expect(rt.getState().dueAt).toBe(offset);
      await fireDue(rt);
      // The charge Cmd went out and the alarm disarmed while it is in flight.
      expect(cmds.at(-1)).toEqual({
        type: "charge",
        subscriptionId: SUB,
        amountCents: AMOUNT,
        rung: n,
      });
      expect(rt.getState().dueAt).toBeNull();
      await rt.dispatch({
        type: "charge_declined",
        reason: "do_not_honor",
        at: offset + 10,
      });
    }

    const grace = rt.getState();
    expect(grace.phase).toBe("grace");
    expect(grace.declines).toHaveLength(4);
    // Grace runs from the LAST decline, not from the anchor.
    expect(grace.dueAt).toBe((RETRY_OFFSETS_MS[2] as number) + 10 + GRACE_MS);

    await fireDue(rt);
    expect(rt.getState().phase).toBe("downgraded");
    expect(isTerminal(rt.getState())).toBe(true);
    expect(cmds.map((cmd) => cmd.type)).toContain("downgrade");

    await rt.stop();
  });

  it("recovers the moment money lands, from anywhere in the ladder", async () => {
    const c = cell();
    const { rt, cmds } = await boot(c);

    await rt.dispatch({
      type: "renewal_declined",
      subscriptionId: SUB,
      amountCents: AMOUNT,
      reason: "expired_card",
      at: 0,
    });
    await fireDue(rt);
    await rt.dispatch({
      type: "charge_declined",
      reason: "expired_card",
      at: RETRY_OFFSETS_MS[0] as number,
    });

    // The customer fixes their card in the portal, between rungs.
    await rt.dispatch({
      type: "payment_succeeded",
      at: 2 * 24 * 60 * 60 * 1000,
    });

    expect(rt.getState().phase).toBe("recovered");
    expect(rt.getState().dueAt).toBeNull();
    expect(cmds.at(-1)).toEqual({
      type: "notify",
      subscriptionId: SUB,
      kind: "recovered",
    });

    // A late alarm after recovery is a no-op — an alarm can fire twice.
    await rt.dispatch({ type: "tick", at: 99 * 24 * 60 * 60 * 1000 });
    expect(rt.getState().phase).toBe("recovered");

    await rt.stop();
  });

  it("derives each rung's deadline from the anchor alone", () => {
    expect(retryDueAt(1_000, 0)).toBe(1_000 + (RETRY_OFFSETS_MS[0] as number));
    expect(retryDueAt(1_000, 2)).toBe(1_000 + (RETRY_OFFSETS_MS[2] as number));
    expect(retryDueAt(1_000, 3)).toBeNull();
  });
});

describe("dunning — resume from serialized state", () => {
  it("resumes mid-grace on a fresh runtime and downgrades on time", async () => {
    const c = cell();
    const first = await boot(c);

    await first.rt.dispatch({
      type: "renewal_declined",
      subscriptionId: SUB,
      amountCents: AMOUNT,
      reason: "insufficient_funds",
      at: 0,
    });
    for (const offset of RETRY_OFFSETS_MS) {
      await fireDue(first.rt);
      await first.rt.dispatch({
        type: "charge_declined",
        reason: "do_not_honor",
        at: offset,
      });
    }
    const owedAt = first.rt.getState().dueAt as number;
    expect(first.rt.getState().phase).toBe("grace");
    await first.rt.stop();

    // Weeks pass. The isolate is long gone; only the row survives.
    const parsed = parseState(JSON.parse(c.raw as string));
    expect(parsed?.phase).toBe("grace");
    expect(parsed?.dueAt).toBe(owedAt);

    const second = await boot(c);
    expect(second.rt.getState().phase).toBe("grace");
    expect(second.rt.getState().declines).toHaveLength(4);

    await second.rt.dispatch({ type: "tick", at: owedAt });
    expect(second.rt.getState().phase).toBe("downgraded");
    expect(second.cmds.map((cmd) => cmd.type)).toEqual(["downgrade", "notify"]);

    await second.rt.stop();
  });
});
