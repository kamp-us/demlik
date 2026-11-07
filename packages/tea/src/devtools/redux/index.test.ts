import { describe, expect, it, vi } from "vitest";
import { type Cmd, defineMachine, type Interpret } from "../../index";
import { replayTrace } from "../../internal/persistence/trace-replay";
import { run } from "../../promise";
import {
  connectReduxDevtools,
  type MonitorMessage,
  parseDevtoolsExport,
  type ReduxDevtoolsConnection,
  type ReduxDevtoolsExtension,
} from "./index";

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
const charge = (cart: readonly Item[], attempt: number): Charge => ({
  type: "charge",
  total: total(cart),
  attempt,
});

function checkout(opts: { discount?: number; withoutRetry?: boolean } = {}) {
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
function retryCell(s: Declined): readonly [State, readonly Charge[]] {
  return [
    {
      type: "paying",
      cart: s.cart,
      address: s.address,
      attempt: s.attempt + 1,
    },
    [charge(s.cart, s.attempt + 1)],
  ];
}

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

// ---------------------------------------------------------------------------
// A stand-in for the extension. It keeps the timeline the way the monitor
// does (`init` starts it at `@@INIT`, `send(action, state)` appends,
// `send(null, lifted)` replaces it), and lets a test press the panel's
// buttons: Export, Import (sent as the extension's `IMPORT_STATE` dispatch),
// and Dispatch (sent as the typed text).
// ---------------------------------------------------------------------------
interface Lifted {
  actionsById: Record<number, { type: string; action: { type: string } }>;
  computedStates: { state: unknown; error?: string }[];
  stagedActionIds: number[];
  skippedActionIds: number[];
  [k: string]: unknown;
}

function fakePanel() {
  const errors: string[] = [];
  const options: Record<string, unknown>[] = [];
  let lifted: Lifted | undefined;
  let listener: ((m: MonitorMessage) => void) | undefined;
  let unsubscribed = false;

  const conn: ReduxDevtoolsConnection = {
    init(state) {
      lifted = {
        actionsById: {
          0: { type: "PERFORM_ACTION", action: { type: "@@INIT" } },
        },
        computedStates: [{ state }],
        stagedActionIds: [0],
        skippedActionIds: [],
        committedState: state,
        currentStateIndex: 0,
        nextActionId: 1,
      };
    },
    send(action, state) {
      if (action === null) {
        lifted = structuredClone(state) as Lifted;
        return;
      }
      if (lifted === undefined) throw new Error("send before init");
      const id = lifted.stagedActionIds.length;
      lifted.actionsById[id] = {
        type: "PERFORM_ACTION",
        action: structuredClone(action),
      };
      lifted.computedStates.push({ state: structuredClone(state) });
      lifted.stagedActionIds.push(id);
    },
    subscribe(l) {
      listener = l;
      return () => {
        listener = undefined;
      };
    },
    unsubscribe() {
      unsubscribed = true;
    },
    error(message) {
      errors.push(message);
    },
  };
  const extension: ReduxDevtoolsExtension = {
    connect(o) {
      options.push(o);
      return conn;
    },
  };

  const press = (m: MonitorMessage) => {
    if (listener === undefined) throw new Error("nothing is subscribed");
    listener(m);
  };
  return {
    extension,
    errors,
    options,
    get unsubscribed() {
      return unsubscribed;
    },
    get listening() {
      return listener !== undefined;
    },
    timeline(): string[] {
      return (lifted?.stagedActionIds ?? []).map(
        (id) => lifted?.actionsById[id]?.action.type ?? "?",
      );
    },
    states(): unknown[] {
      return (lifted?.computedStates ?? []).map((c) => c.state);
    },
    stateErrors(): (string | undefined)[] {
      return (lifted?.computedStates ?? []).map((c) => c.error);
    },
    exportFile(): string {
      return JSON.stringify(lifted, null, "\t");
    },
    importFile(file: string) {
      press({
        type: "DISPATCH",
        payload: { type: "IMPORT_STATE", nextLiftedState: JSON.parse(file) },
      });
    },
    dispatch(text: string) {
      press({ type: "ACTION", payload: text });
    },
    jump(index: number) {
      press({ type: "DISPATCH", payload: { type: "JUMP_TO_STATE", index } });
    },
  };
}

async function recordSession() {
  const panel = fakePanel();
  const live = bank();
  const runtime = run(checkout(), { ctx: {}, interpret: live.interpret });
  connectReduxDevtools(checkout(), runtime, {
    extension: panel.extension,
    dispatch: runtime.dispatch,
  });
  const booted = await runtime.ready;
  for (const m of shopperSession) await runtime.dispatch(m);
  await booted.stop();
  return { panel, live, finalState: booted.getState() };
}

describe("a shopper's session, watched, exported and imported into a fresh tab", () => {
  it("shows every Msg live, and the exported file replays exactly with zero effects", async () => {
    const { panel, live, finalState } = await recordSession();

    // Live: @@INIT plus the 21 Msgs the shopper sent plus the 2 the bank answered.
    const timeline = panel.timeline();
    expect(timeline).toHaveLength(1 + shopperSession.length + 2);
    expect(timeline.slice(0, 3)).toEqual(["@@INIT", "add", "add"]);
    expect(timeline.slice(-4)).toEqual(["pay", "declined", "retry", "charged"]);
    expect(panel.states().at(-1)).toEqual(finalState);
    expect(finalState).toMatchObject({ type: "paid", orderId: "order-94" });
    expect(live.calls).toHaveLength(2);
    expect(panel.errors).toEqual([]);

    // Export → import in a fresh tab, running the same code.
    const file = panel.exportFile();
    const tab = fakePanel();
    const freshBank = bank();
    const fresh = run(checkout(), { ctx: {}, interpret: freshBank.interpret });
    connectReduxDevtools(checkout(), fresh, { extension: tab.extension });
    await fresh.ready;
    tab.importFile(file);

    expect(tab.errors).toEqual([]);
    expect(tab.timeline()).toEqual(timeline);
    expect(tab.states()).toEqual(panel.states());
    // Replay ran no effect: the fresh tab's bank was never called.
    expect(freshBank.calls).toEqual([]);
    await (await fresh.ready).stop();
  });

  it("names the first Msg where edited code diverges, and shows the new states", async () => {
    const { panel } = await recordSession();

    const tab = fakePanel();
    const edited = checkout({ discount: 1 });
    const fresh = run(edited, { ctx: {}, interpret: bank().interpret });
    connectReduxDevtools(edited, fresh, { extension: tab.extension });
    await fresh.ready;
    tab.importFile(panel.exportFile());

    expect(tab.errors).toEqual([
      'tea: your current code diverges from this session at Msg #1 "add": state.cart[0].price was 10, now 9.',
    ]);
    // The panel now shows what the edited code computes for the same Msgs.
    expect(tab.timeline()).toEqual(panel.timeline());
    expect(tab.states().at(1)).toEqual({
      type: "shopping",
      cart: [{ sku: "tea", price: 9 }],
    });
    await (await fresh.ready).stop();
  });

  it("refuses a session holding a Msg the machine no longer has, naming it", async () => {
    const { panel } = await recordSession();
    // A refactor removed `retry`: a declined card can only go back.
    const refactored = checkout({ withoutRetry: true });

    const tab = fakePanel();
    const fresh = run(refactored, { ctx: {}, interpret: bank().interpret });
    connectReduxDevtools(refactored, fresh, { extension: tab.extension });
    await fresh.ready;
    tab.importFile(panel.exportFile());

    expect(tab.errors).toEqual([
      'tea: your machine cannot replay this session. Msg #22 "retry" has no cell in state "declined" (it accepts back).',
    ]);
    // Everything up to the refused Msg is shown, and the refused one carries
    // the reason as its error.
    expect(tab.timeline()).toHaveLength(1 + 22);
    expect(tab.timeline().at(-1)).toBe("retry");
    expect(tab.stateErrors().at(-1)).toMatch(/no cell in state "declined"/);
    await (await fresh.ready).stop();
  });

  it("turns the exported file into a regression test with parseDevtoolsExport", async () => {
    const { panel } = await recordSession();
    const trace = parseDevtoolsExport<State, Msg>(panel.exportFile());

    expect(trace.msgs).toHaveLength(shopperSession.length + 2);
    expect(replayTrace(checkout(), trace).matches).toBe(true);

    const edited = replayTrace(checkout({ discount: 1 }), trace);
    expect(edited.matches).toBe(false);
    expect(edited.divergence?.at).toEqual({
      index: 0,
      msg: { type: "add", sku: "tea", price: 10 },
    });

    // The wrapped form the panel's client-side export writes reads the same.
    const wrapped = JSON.stringify({ payload: panel.exportFile() });
    expect(parseDevtoolsExport<State, Msg>(wrapped)).toEqual(trace);
    expect(() => parseDevtoolsExport("[]")).toThrow(
      /not a Redux DevTools session/,
    );
  });
});

describe("the panel's Dispatch box", () => {
  it("sends a Msg typed the way the panel's box starts, and refuses one the state does not take", async () => {
    const panel = fakePanel();
    const runtime = run(checkout(), { ctx: {}, interpret: bank().interpret });
    connectReduxDevtools(checkout(), runtime, {
      extension: panel.extension,
      dispatch: runtime.dispatch,
    });
    const booted = await runtime.ready;

    // The box opens holding "{\n  type: ''\n}"; people fill it in place.
    panel.dispatch("{\n  type: 'add',\n  sku: 'tea',\n  price: 10\n}");
    panel.dispatch('{"type":"add","sku":"it\'s \\"cup\\"","price":4,}');
    panel.dispatch(
      "{ type: 'add', sku: 'pot', price: 6, gift: true, note: null, }",
    );
    await vi.waitFor(() =>
      expect(booted.getState()).toMatchObject({
        cart: [
          { sku: "tea", price: 10 },
          { sku: 'it\'s "cup"', price: 4 },
          { sku: "pot", price: 6 },
        ],
      }),
    );

    const hint = `tea: type the Msg as an object with a string type, e.g. { type: 'increment' }.`;
    panel.dispatch("{ type: 'pay' }");
    panel.dispatch("{ type: increment }");
    panel.dispatch("{ type: (globalThis.ran = 'add') }");
    panel.dispatch("{ type: '' ");
    expect(panel.errors).toEqual([
      'tea: the current state takes no "pay" Msg. It accepts: add, remove, checkout.',
      hint,
      hint,
      hint,
    ]);
    expect((globalThis as { ran?: unknown }).ran).toBeUndefined();
    expect(booted.getState().type).toBe("shopping");
    expect(panel.options[0]).toMatchObject({
      features: { dispatch: true, jump: false },
    });
    await booted.stop();
  });

  it("is switched off when no dispatch is given", async () => {
    const panel = fakePanel();
    const runtime = run(checkout(), { ctx: {}, interpret: bank().interpret });
    connectReduxDevtools(checkout(), runtime, { extension: panel.extension });
    const booted = await runtime.ready;
    panel.dispatch('{"type":"add","sku":"tea","price":10}');
    expect(booted.getState()).toEqual({ type: "shopping", cart: [] });
    expect(panel.options[0]).toMatchObject({ features: { dispatch: false } });
    await booted.stop();
  });
});

describe("what the bridge never does", () => {
  it("never rewinds the live run when the panel jumps", async () => {
    const panel = fakePanel();
    const runtime = run(checkout(), { ctx: {}, interpret: bank().interpret });
    connectReduxDevtools(checkout(), runtime, { extension: panel.extension });
    const booted = await runtime.ready;
    await booted.dispatch({ type: "add", sku: "tea", price: 10 });
    panel.jump(0);
    expect(booted.getState()).toEqual({
      type: "shopping",
      cart: [{ sku: "tea", price: 10 }],
    });
    await booted.stop();
  });

  it("does nothing without the extension, and disconnects cleanly", async () => {
    const runtime = run(checkout(), { ctx: {}, interpret: bank().interpret });
    const absent = connectReduxDevtools(checkout(), runtime);
    expect(absent.connected).toBe(false);
    absent.disconnect();

    const panel = fakePanel();
    const bridge = connectReduxDevtools(checkout(), runtime, {
      extension: panel.extension,
    });
    const booted = await runtime.ready;
    bridge.disconnect();
    bridge.disconnect();
    await booted.dispatch({ type: "add", sku: "tea", price: 10 });
    expect(bridge.connected).toBe(false);
    expect(panel.timeline()).toEqual(["@@INIT"]);
    expect(panel.unsubscribed).toBe(true);
    expect(panel.listening).toBe(false);
    await booted.stop();
  });
});
