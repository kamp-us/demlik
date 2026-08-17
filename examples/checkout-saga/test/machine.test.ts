import { ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { run, type Store } from "../../../src/index";
import { checkoutInterpret } from "../src/handlers";
import type { State } from "../src/machine";
import {
  checkoutMachine,
  declinesFor,
  parseState,
  paymentRetryPolicy,
  REFUND_WAIT_MS,
  RESERVE_WAIT_MS,
  retryDelayMs,
  update,
} from "../src/machine";
import { CheckoutLayer } from "../src/services";

const SETTLES = "order-1";
const REFUNDS = "oos-1";

/**
 * A Store that round-trips through JSON exactly like `doStore` does, so the
 * resume tests are a real serialization boundary and not a shared object.
 */
function memStore(cell: { raw: string | null }): Store<State> {
  return {
    async load() {
      return cell.raw === null ? null : JSON.parse(cell.raw);
    },
    async save(state) {
      cell.raw = JSON.stringify(state);
    },
    migrate: parseState,
  };
}

async function boot(cell: { raw: string | null }) {
  const managed = ManagedRuntime.make(CheckoutLayer);
  const rt = await run(checkoutMachine(checkoutInterpret(managed)), {
    ctx: {},
    store: memStore(cell),
  }).ready;
  return { rt, managed };
}

type Rt = Awaited<ReturnType<typeof boot>>["rt"];

/** Fire the tick the DO alarm would have fired, without waiting for it. */
async function fireDue(rt: Rt) {
  const due = rt.getState().dueAt;
  expect(due).not.toBeNull();
  await rt.dispatch({ type: "tick", at: due as number });
}

/** Walk the payment ladder to the point the card goes through. */
async function clearPayment(rt: Rt, orderId: string) {
  for (let n = 1; n <= declinesFor(orderId); n++) await fireDue(rt);
}

describe("checkout saga — happy path", () => {
  it("walks paying → reserving → settled, with every wait in State", async () => {
    const cell = { raw: null as string | null };
    const { rt, managed } = await boot(cell);

    await rt.dispatch({
      type: "start",
      orderId: SETTLES,
      amountCents: 4200,
      at: 0,
    });

    // The provider declined; the ladder is VISIBLE STATE, not fiber state.
    expect(rt.getState().phase).toBe("paying");
    expect(rt.getState().attempt).toBe(1);
    const due = rt.getState().dueAt as number;
    expect(due - Date.now()).toBeLessThanOrEqual(retryDelayMs(1));
    expect(due - Date.now()).toBeGreaterThan(retryDelayMs(1) - 500);

    for (let n = 2; n <= declinesFor(SETTLES); n++) {
      await fireDue(rt);
      expect(rt.getState().attempt).toBe(n);
      expect(rt.getState().phase).toBe("paying");
    }

    // The card goes through, and the saga moves into a REAL waiting phase.
    await fireDue(rt);
    const reserving = rt.getState();
    expect(reserving.phase).toBe("reserving");
    expect(reserving.attempt).toBe(declinesFor(SETTLES) + 1);
    expect(reserving.paymentRef).toBe(
      `pay_${SETTLES}_4200_a${declinesFor(SETTLES) + 1}`,
    );
    // Reserving is not instantaneous: the warehouse's answer is scheduled.
    expect(reserving.dueAt).not.toBeNull();
    expect((reserving.dueAt as number) - Date.now()).toBeGreaterThan(
      RESERVE_WAIT_MS - 500,
    );

    await fireDue(rt);
    expect(rt.getState().phase).toBe("settled");
    expect(rt.getState().dueAt).toBeNull();
    expect(rt.getState().log.map((l) => l.text)).toContain(
      "stock reserved — order settled",
    );

    await rt.stop();
    await managed.dispose();
  });
});

describe("checkout saga — refund path", () => {
  it("walks reserving → refunding → failed and returns the money", async () => {
    const cell = { raw: null as string | null };
    const { rt, managed } = await boot(cell);

    await rt.dispatch({
      type: "start",
      orderId: REFUNDS,
      amountCents: 999,
      at: 0,
    });
    // The refund scenario clears payment fast so the interesting part arrives.
    expect(declinesFor(REFUNDS)).toBeLessThan(declinesFor(SETTLES));
    await clearPayment(rt, REFUNDS);

    expect(rt.getState().phase).toBe("reserving");
    const captured = rt.getState().paymentRef;
    expect(captured).not.toBeNull();

    // The warehouse answers, badly.
    await fireDue(rt);
    const refunding = rt.getState();
    expect(refunding.phase).toBe("refunding");
    expect(refunding.failure).toBe(`out of stock: ${REFUNDS}`);
    // Refunding is a REAL phase with a scheduled end, not a blip.
    expect(refunding.dueAt).not.toBeNull();
    expect((refunding.dueAt as number) - Date.now()).toBeGreaterThan(
      REFUND_WAIT_MS - 500,
    );
    expect(refunding.refunded).toBe(false);

    await fireDue(rt);
    expect(rt.getState().phase).toBe("failed");
    expect(rt.getState().refunded).toBe(true);
    expect(rt.getState().paymentRef).toBe(captured);

    await rt.stop();
    await managed.dispose();
  });
});

describe("checkout saga — surviving the process", () => {
  it("resumes the retry ladder from storage after the process dies", async () => {
    const cell = { raw: null as string | null };
    const first = await boot(cell);

    await first.rt.dispatch({
      type: "start",
      orderId: SETTLES,
      amountCents: 1500,
      at: 0,
    });
    await fireDue(first.rt);
    expect(first.rt.getState().attempt).toBe(2);

    // ── the crash ───────────────────────────────────────────────────────────
    await first.rt.stop();
    await first.managed.dispose();

    const second = await boot(cell);
    expect(second.rt.getState().phase).toBe("paying");
    expect(second.rt.getState().attempt).toBe(2);
    expect(second.rt.getState().dueAt).not.toBeNull();

    for (let n = 2; n <= declinesFor(SETTLES); n++) await fireDue(second.rt);
    await fireDue(second.rt); // the warehouse answers
    expect(second.rt.getState().phase).toBe("settled");

    await second.rt.stop();
    await second.managed.dispose();
  });

  it("resumes a RESERVATION that was in flight when the process died", async () => {
    const cell = { raw: null as string | null };
    const first = await boot(cell);

    await first.rt.dispatch({
      type: "start",
      orderId: SETTLES,
      amountCents: 4200,
      at: 0,
    });
    await clearPayment(first.rt, SETTLES);
    expect(first.rt.getState().phase).toBe("reserving");
    const dueAt = first.rt.getState().dueAt;

    // Die mid-reservation — money already taken, order not yet fulfilled.
    await first.rt.stop();
    await first.managed.dispose();

    const second = await boot(cell);
    expect(second.rt.getState().phase).toBe("reserving");
    expect(second.rt.getState().dueAt).toBe(dueAt);
    expect(second.rt.getState().paymentRef).not.toBeNull();

    await fireDue(second.rt);
    expect(second.rt.getState().phase).toBe("settled");

    await second.rt.stop();
    await second.managed.dispose();
  });

  it("resumes a REFUND that was in flight when the process died", async () => {
    // The nastiest case: the customer has been charged, the order cannot be
    // filled, and the process dies holding the obligation to give the money
    // back. Because the obligation is State, it survives.
    const cell = { raw: null as string | null };
    const first = await boot(cell);

    await first.rt.dispatch({
      type: "start",
      orderId: REFUNDS,
      amountCents: 999,
      at: 0,
    });
    await clearPayment(first.rt, REFUNDS);
    await fireDue(first.rt); // warehouse says no
    expect(first.rt.getState().phase).toBe("refunding");
    expect(first.rt.getState().refunded).toBe(false);
    const owedTo = first.rt.getState().paymentRef;

    // Die owing a refund.
    await first.rt.stop();
    await first.managed.dispose();

    const second = await boot(cell);
    expect(second.rt.getState().phase).toBe("refunding");
    expect(second.rt.getState().paymentRef).toBe(owedTo);
    expect(second.rt.getState().refunded).toBe(false);
    expect(second.rt.getState().dueAt).not.toBeNull();

    await fireDue(second.rt);
    expect(second.rt.getState().phase).toBe("failed");
    expect(second.rt.getState().refunded).toBe(true);

    await second.rt.stop();
    await second.managed.dispose();
  });
});

describe("checkout saga — start semantics", () => {
  it("restarts a saga that was killed mid-ladder", async () => {
    // An order killed mid-retry is still "paying" as far as State knows, and
    // `start` used to no-op on any non-terminal saga — so pressing Start again
    // did nothing, silently, while the other lane restarted.
    const cell = { raw: null as string | null };
    const { rt, managed } = await boot(cell);

    await rt.dispatch({
      type: "start",
      orderId: SETTLES,
      amountCents: 700,
      at: 0,
    });
    await fireDue(rt);
    expect(rt.getState().attempt).toBe(2);

    const wellAfter = (rt.getState().log.at(-1)?.at ?? 0) + 60_000;
    await rt.dispatch({
      type: "start",
      orderId: SETTLES,
      amountCents: 700,
      at: wellAfter,
    });
    expect(rt.getState().attempt).toBe(1);
    expect(rt.getState().phase).toBe("paying");
    expect(rt.getState().paymentRef).toBeNull();

    await rt.stop();
    await managed.dispose();
  });

  it("ignores a double-click on start", async () => {
    const cell = { raw: null as string | null };
    const { rt, managed } = await boot(cell);

    await rt.dispatch({
      type: "start",
      orderId: SETTLES,
      amountCents: 700,
      at: 0,
    });
    await fireDue(rt);
    const before = rt.getState();

    await rt.dispatch({
      type: "start",
      orderId: SETTLES,
      amountCents: 700,
      at: (before.log.at(-1)?.at ?? 0) + 10,
    });
    expect(rt.getState().attempt).toBe(before.attempt);
    expect(rt.getState().log.length).toBe(before.log.length);

    await rt.stop();
    await managed.dispose();
  });
});

describe("checkout saga — reducer edges", () => {
  it("gives up after the retry budget and never charges again", async () => {
    const cell = { raw: null as string | null };
    const { rt, managed } = await boot(cell);

    await rt.dispatch({
      type: "start",
      orderId: SETTLES,
      amountCents: 10,
      at: 0,
    });
    // The fake provider accepts once past its decline count, so the give-up arm
    // is unreachable through it. Assert the reducer directly instead.
    const stuck: State = {
      ...rt.getState(),
      phase: "paying",
      attempt: paymentRetryPolicy.maxAttempts,
      dueAt: null,
    };
    const [next, cmds] = update.payment_failed(stuck, {
      type: "payment_failed",
      reason: "hard decline",
      at: 1,
    });
    expect(next.phase).toBe("failed");
    expect(next.failure).toBe("hard decline");
    expect(cmds).toEqual([]);

    await rt.stop();
    await managed.dispose();
  });

  it("ignores an early or duplicate tick", async () => {
    // An alarm can fire twice across a cold wake. A stale tick must not
    // double-charge or skip a phase.
    const cell = { raw: null as string | null };
    const { rt, managed } = await boot(cell);

    await rt.dispatch({
      type: "start",
      orderId: SETTLES,
      amountCents: 10,
      at: 0,
    });
    const before = rt.getState();

    await rt.dispatch({ type: "tick", at: (before.dueAt as number) - 1 });
    expect(rt.getState().attempt).toBe(before.attempt);
    expect(rt.getState().log.length).toBe(before.log.length);

    // And a tick with nothing scheduled is inert.
    const settledish: State = { ...before, dueAt: null };
    const [after, cmds] = update.tick(settledish, { type: "tick", at: 9_999 });
    expect(after).toBe(settledish);
    expect(cmds).toEqual([]);

    await rt.stop();
    await managed.dispose();
  });
});
