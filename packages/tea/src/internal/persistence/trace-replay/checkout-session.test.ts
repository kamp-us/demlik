// A real recorded session, saved and replayed through changed code: the job a
// bug report hands you. Recorded on the Promise engine with `captureSteps`.
import { describe, expect, it, vi } from "vitest";
import { type Cmd, defineMachine, type Interpret } from "../../../index";
import { run } from "../../../promise";
import { parseJSONL, recorder } from "../recorder";
import { replayTrace } from "./index";

// ---------------------------------------------------------------------------
// A checkout: a cart, an address, a card that is declined once, a retry, and
// a payment. Transitions form, so each state accepts only its own Msgs.
// ---------------------------------------------------------------------------
type Item = { readonly sku: string; readonly price: number };
type State =
  | { readonly type: "shopping"; readonly cart: readonly Item[] }
  | {
      readonly type: "checkout";
      readonly cart: readonly Item[];
      readonly address: string | null;
    }
  | {
      readonly type: "paying";
      readonly cart: readonly Item[];
      readonly address: string;
      readonly attempt: number;
    }
  | {
      readonly type: "declined";
      readonly cart: readonly Item[];
      readonly address: string;
      readonly attempt: number;
      readonly reason: string;
    }
  | {
      readonly type: "paid";
      readonly cart: readonly Item[];
      readonly orderId: string;
    };
type Msg =
  | { readonly type: "add"; readonly sku: string; readonly price: number }
  | { readonly type: "remove"; readonly sku: string }
  | { readonly type: "checkout" }
  | { readonly type: "back" }
  | { readonly type: "address"; readonly text: string }
  | { readonly type: "pay" }
  | { readonly type: "charged"; readonly orderId: string }
  | { readonly type: "declined"; readonly reason: string }
  | { readonly type: "retry" };
type Charge = Cmd<"charge"> & {
  readonly total: number;
  readonly attempt: number;
};
type Ctx = Record<string, never>;

const total = (cart: readonly Item[]) => cart.reduce((n, i) => n + i.price, 0);
function checkout(
  opts: { discount?: number; withoutRetry?: boolean; fee?: number } = {},
) {
  // A fee changes what the bank is asked for, and no State: the cart, the
  // address and the order id stay as they were.
  const charge = (cart: readonly Item[], attempt: number): Charge => ({
    type: "charge",
    total: total(cart) + (opts.fee ?? 0),
    attempt,
  });
  const retryCell = (s: Declined): readonly [State, readonly Charge[]] => [
    {
      type: "paying",
      cart: s.cart,
      address: s.address,
      attempt: s.attempt + 1,
    },
    [charge(s.cart, s.attempt + 1)],
  ];
  const priceOf = (m: { price: number }) => m.price - (opts.discount ?? 0);
  return defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      cmd: {} as Charge,
      ctx: {} as Ctx,
    },
    init: (loaded) => [loaded ?? { type: "shopping", cart: [] }, []],
    update: {
      shopping: {
        add: (s, m) => [
          { ...s, cart: [...s.cart, { sku: m.sku, price: priceOf(m) }] },
          [],
        ],
        remove: (s, m) => [
          { ...s, cart: s.cart.filter((i) => i.sku !== m.sku) },
          [],
        ],
        checkout: (s) => [
          { type: "checkout", cart: s.cart, address: null },
          [],
        ],
      },
      checkout: {
        address: (s, m) => [{ ...s, address: m.text }, []],
        back: (s) => [{ type: "shopping", cart: s.cart }, []],
        pay: (s) =>
          s.address === null
            ? [s, []]
            : [
                {
                  type: "paying",
                  cart: s.cart,
                  address: s.address,
                  attempt: 1,
                },
                [charge(s.cart, 1)],
              ],
      },
      paying: {
        charged: (s, m) => [
          { type: "paid", cart: s.cart, orderId: m.orderId },
          [],
        ],
        declined: (s, m) => [
          {
            type: "declined",
            cart: s.cart,
            address: s.address,
            attempt: s.attempt,
            reason: m.reason,
          },
          [],
        ],
      },
      declined: {
        ...(opts.withoutRetry ? {} : { retry: retryCell }),
        back: (s) => [{ type: "shopping", cart: s.cart }, []],
      },
      paid: {},
    },
  });
}

type Declined = Extract<State, { type: "declined" }>;

/** The card is declined on the first attempt and charged on the second. */
function bank() {
  const calls: Charge[] = [];
  const interpret: Interpret<Msg, Charge, Ctx> = {
    charge: async (cmd): Promise<Msg> => {
      calls.push(cmd);
      return cmd.attempt === 1
        ? { type: "declined", reason: "insufficient funds" }
        : { type: "charged", orderId: `order-${cmd.total}` };
    },
  };
  return { calls, interpret };
}

// The session a shopper drives by hand: 21 Msgs, and the bank adds 2 more.
const SKUS = ["tea", "cup", "pot", "tray", "spoon", "kettle", "sugar", "milk"];
const shopperSession: Msg[] = [
  ...SKUS.map((sku, i) => ({ type: "add", sku, price: 10 + i }) as const),
  { type: "remove", sku: "sugar" },
  { type: "remove", sku: "tray" },
  { type: "add", sku: "honey", price: 7 },
  { type: "add", sku: "lemon", price: 3 },
  { type: "checkout" },
  { type: "back" },
  { type: "add", sku: "saucer", price: 5 },
  { type: "checkout" },
  { type: "pay" },
  { type: "address", text: "Moda, Kadıköy" },
  { type: "address", text: "Moda Cd. 12, Kadıköy" },
  { type: "pay" },
  { type: "retry" },
];

/** Drive the shopper's session on a real run and save it as JSONL. */
async function recordSession() {
  const live = bank();
  const runtime = run(checkout(), { ctx: {}, interpret: live.interpret });
  const rec = recorder(runtime, { captureSteps: true });
  const booted = await runtime.ready;
  for (const msg of shopperSession) await booted.dispatch(msg);
  await vi.waitFor(() => expect(booted.getState().type).toBe("paid"));
  await booted.stop();
  return { jsonl: rec.toJSONL(), charges: live.calls };
}

describe("a saved checkout session replayed through your current code", () => {
  it("replays every step through the code that recorded it, running no effect", async () => {
    const { jsonl, charges } = await recordSession();
    expect(charges).toHaveLength(2);

    const result = replayTrace(checkout(), parseJSONL<State, Msg>(jsonl));

    expect(result.matches).toBe(true);
    expect(result.divergence).toBeUndefined();
    expect(result.refusal).toBeUndefined();
    expect(result.states).toHaveLength(23);
    expect(result.actual).toMatchObject({ type: "paid", orderId: "order-94" });
    expect(result.cmds[19]).toEqual([
      { type: "charge", total: 94, attempt: 1 },
    ]);
    expect(charges).toHaveLength(2);
  });

  it("keeps each step's Cmds through the saved JSONL, as the run started them", async () => {
    const { jsonl, charges } = await recordSession();

    const steps = parseJSONL<State, Msg>(jsonl).steps ?? [];

    expect(steps).toHaveLength(23);
    expect(steps[19]?.msg).toEqual({ type: "pay" });
    expect(steps[19]?.cmds).toEqual([charges[0]]);
    expect(steps[21]?.cmds).toEqual([charges[1]]);
    expect(steps.filter((step) => (step.cmds ?? []).length > 0)).toHaveLength(
      2,
    );
  });

  it("names the Msg whose Cmd a change altered, when every State stays the same", async () => {
    const { jsonl } = await recordSession();

    const result = replayTrace(
      checkout({ fee: 2 }),
      parseJSONL<State, Msg>(jsonl),
    );

    expect(result.matches).toBe(false);
    expect(result.divergence).toEqual({
      path: "cmds[0].total",
      expected: 94,
      actual: 96,
      at: { index: 19, msg: { type: "pay" } },
    });
    expect(result.states).toHaveLength(23);
    expect(result.actual).toMatchObject({ type: "paid", orderId: "order-94" });
  });

  it("names the first Msg where a changed price rule parts from the recording", async () => {
    const { jsonl } = await recordSession();

    const result = replayTrace(
      checkout({ discount: 1 }),
      parseJSONL<State, Msg>(jsonl),
    );

    expect(result.matches).toBe(false);
    expect(result.divergence).toMatchObject({
      path: "state.cart[0].price",
      expected: 10,
      actual: 9,
      at: { index: 0, msg: { type: "add", sku: "tea" } },
    });
    expect(result.states).toHaveLength(23);
  });

  it("stops at the Msg a state no longer accepts, and says what it accepts", async () => {
    const { jsonl } = await recordSession();

    const result = replayTrace(
      checkout({ withoutRetry: true }),
      parseJSONL<State, Msg>(jsonl),
    );

    expect(result.matches).toBe(false);
    expect(result.refusal).toEqual({
      index: 21,
      msg: { type: "retry" },
      stateName: "declined",
      acceptedTypes: ["back"],
    });
    expect(result.states).toHaveLength(21);
    expect(result.actual).toMatchObject({ type: "declined", attempt: 1 });
  });
});
