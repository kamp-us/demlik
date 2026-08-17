import { ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import { run, type Store } from "../../../src/index";
import { checkoutInterpret } from "../src/handlers";
import type { State } from "../src/machine";
import {
  checkoutMachine,
  parseState,
  retryDelayMs,
  update,
} from "../src/machine";
import { CheckoutLayer, FLAKY_ATTEMPTS } from "../src/services";

/**
 * A Store that round-trips through JSON exactly like `doStore` does, so the
 * resume test is a real serialization boundary and not a shared object.
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

/** Fire the retry the DO alarm would have fired, without waiting for it. */
async function fireRetry(rt: Awaited<ReturnType<typeof boot>>["rt"]) {
  const due = rt.getState().nextRetryAt;
  expect(due).not.toBeNull();
  await rt.dispatch({ type: "retry_now", at: due as number });
}

describe("checkout saga", () => {
  it("retries a declined payment and settles", async () => {
    const cell = { raw: null as string | null };
    const { rt, managed } = await boot(cell);

    await rt.dispatch({
      type: "start",
      orderId: "order-1",
      amountCents: 4200,
      at: 0,
    });

    // The provider declined; the ladder is VISIBLE STATE, not fiber state.
    expect(rt.getState().phase).toBe("paying");
    expect(rt.getState().attempt).toBe(1);
    // `at` is stamped at the effect boundary, so assert the DELAY, not the
    // absolute instant.
    const due = rt.getState().nextRetryAt as number;
    expect(due - Date.now()).toBeLessThanOrEqual(retryDelayMs(1));
    expect(due - Date.now()).toBeGreaterThan(retryDelayMs(1) - 500);

    await fireRetry(rt);
    expect(rt.getState().attempt).toBe(2);
    expect(rt.getState().phase).toBe("paying");

    await fireRetry(rt);
    expect(rt.getState().attempt).toBe(FLAKY_ATTEMPTS + 1);
    expect(rt.getState().phase).toBe("settled");
    expect(rt.getState().paymentRef).toMatch(/^pay_order-1_4200_a3$/);

    await rt.stop();
    await managed.dispose();
  });

  it("compensates with a refund when the reservation fails", async () => {
    const cell = { raw: null as string | null };
    const { rt, managed } = await boot(cell);

    await rt.dispatch({
      type: "start",
      orderId: "oos-9",
      amountCents: 999,
      at: 0,
    });
    await fireRetry(rt);
    await fireRetry(rt);

    // Payment succeeded, reservation did not, so the money went back.
    expect(rt.getState().paymentRef).not.toBeNull();
    expect(rt.getState().phase).toBe("failed");
    expect(rt.getState().failure).toBe("out of stock: oos-9");
    expect(rt.getState().log.map((l) => l.text)).toContain(
      "refund issued — order failed cleanly",
    );

    await rt.stop();
    await managed.dispose();
  });

  it("resumes the retry ladder from storage after the process dies", async () => {
    const cell = { raw: null as string | null };
    const first = await boot(cell);

    await first.rt.dispatch({
      type: "start",
      orderId: "order-2",
      amountCents: 1500,
      at: 0,
    });
    await fireRetry(first.rt);
    expect(first.rt.getState().attempt).toBe(2);

    // ── the crash ────────────────────────────────────────────────────────────
    // Drop the runtime AND the Effect runtime on the floor mid-ladder. Nothing
    // in memory survives; only `cell.raw` does.
    await first.rt.stop();
    await first.managed.dispose();

    const second = await boot(cell);
    expect(second.rt.getState().phase).toBe("paying");
    expect(second.rt.getState().attempt).toBe(2);
    expect(second.rt.getState().nextRetryAt).not.toBeNull();

    await fireRetry(second.rt);
    expect(second.rt.getState().phase).toBe("settled");
    expect(second.rt.getState().attempt).toBe(3);

    await second.rt.stop();
    await second.managed.dispose();
  });

  it("gives up after the retry budget and never charges again", async () => {
    const cell = { raw: null as string | null };
    const { rt, managed } = await boot(cell);

    // Bump the flaky window past the budget by charging an order the provider
    // never accepts: exhaust maxAttempts by firing every scheduled retry.
    await rt.dispatch({
      type: "start",
      orderId: "order-3",
      amountCents: 10,
      at: 0,
    });
    // attempts 1 and 2 are declined, 3 succeeds — so to see the give-up arm we
    // assert the reducer directly instead of fighting the fake provider.
    const stuck: State = {
      ...rt.getState(),
      phase: "paying",
      attempt: 4,
      nextRetryAt: null,
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
});
