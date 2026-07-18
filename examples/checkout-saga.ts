import {
  type Cmd,
  defineMachine,
  type Runtime,
  run,
  tryInterpret,
} from "@demlik/tea";
import { createSaga, type SagaState } from "@demlik/tea/saga";

type DoCmd =
  | (Cmd<"reserve_stock"> & { sku: string; qty: number })
  | (Cmd<"charge_card"> & { cents: number })
  | (Cmd<"ship"> & { sku: string; address: string });

type UndoCmd =
  | (Cmd<"release_stock"> & { sku: string; qty: number })
  | (Cmd<"refund_card"> & { cents: number })
  | (Cmd<"unship"> & { sku: string });

type StepCmd = DoCmd | UndoCmd;

type Msg =
  | { type: "begin" }
  | { type: "step_ok"; ref: string }
  | { type: "step_err"; error: string }
  | { type: "undo_ok"; ref: string }
  | { type: "undo_err"; error: string };

interface State {
  saga: SagaState;
  log: readonly string[];
}

interface Ctx {
  warehouse: { reserve(sku: string, qty: number): Promise<string> };
  gateway: { charge(cents: number): Promise<string> };
  carrier: { ship(sku: string, address: string): Promise<string> };
  refunds: { release(sku: string, qty: number): Promise<string> };
}

const saga = createSaga<DoCmd, UndoCmd>({
  steps: [
    {
      do: { type: "reserve_stock", sku: "TEA-001", qty: 2 },
      undo: { type: "release_stock", sku: "TEA-001", qty: 2 },
    },
    {
      do: { type: "charge_card", cents: 4200 },
      undo: { type: "refund_card", cents: 4200 },
    },
    {
      do: { type: "ship", sku: "TEA-001", address: "42 Demlik Ln" },
      undo: { type: "unship", sku: "TEA-001" },
    },
  ],
});

function note(state: State, line: string): State {
  return { ...state, log: [...state.log, line] };
}

export const checkout = defineMachine<State, Msg, StepCmd, never, Ctx>({
  init: (loaded) =>
    loaded !== null ? [loaded, []] : [{ saga: saga.init(), log: [] }, []],

  update: {
    begin: (s) => {
      const [next, cmds] = saga.start(s.saga);
      return [note({ ...s, saga: next }, "begin checkout"), cmds];
    },

    step_ok: (s, m) => {
      const [next, cmds] = saga.stepOk(s.saga);
      const tag = saga.isCommitted(next) ? "committed" : `forward -> ${m.ref}`;
      return [note({ ...s, saga: next }, tag), cmds];
    },

    step_err: (s, m) => {
      const [next, cmds] = saga.stepErr(s.saga, m.error);
      return [note({ ...s, saga: next }, `step failed: ${m.error}`), cmds];
    },

    undo_ok: (s, m) => {
      const [next, cmds] = saga.undoOk(s.saga);
      const tag = saga.isAborted(next)
        ? "aborted (fully rolled back)"
        : `compensated -> ${m.ref}`;
      return [note({ ...s, saga: next }, tag), cmds];
    },

    undo_err: (s, m) => {
      const [next, cmds] = saga.undoErr(s.saga, m.error);
      return [
        note({ ...s, saga: next }, `compensation failed: ${m.error}`),
        cmds,
      ];
    },
  },

  interpret: {
    reserve_stock: tryInterpret<
      DoCmd & { type: "reserve_stock" },
      string,
      Msg,
      Ctx
    >(
      (cmd, ctx) => ctx.warehouse.reserve(cmd.sku, cmd.qty),
      (ref) => ({ type: "step_ok", ref }),
      (err) => ({ type: "step_err", error: String(err) }),
    ),
    charge_card: tryInterpret<
      DoCmd & { type: "charge_card" },
      string,
      Msg,
      Ctx
    >(
      (cmd, ctx) => ctx.gateway.charge(cmd.cents),
      (ref) => ({ type: "step_ok", ref }),
      (err) => ({ type: "step_err", error: String(err) }),
    ),
    ship: tryInterpret<DoCmd & { type: "ship" }, string, Msg, Ctx>(
      (cmd, ctx) => ctx.carrier.ship(cmd.sku, cmd.address),
      (ref) => ({ type: "step_ok", ref }),
      (err) => ({ type: "step_err", error: String(err) }),
    ),
    release_stock: tryInterpret<
      UndoCmd & { type: "release_stock" },
      string,
      Msg,
      Ctx
    >(
      (cmd, ctx) => ctx.refunds.release(cmd.sku, cmd.qty),
      (ref) => ({ type: "undo_ok", ref }),
      (err) => ({ type: "undo_err", error: String(err) }),
    ),
    refund_card: tryInterpret<
      UndoCmd & { type: "refund_card" },
      string,
      Msg,
      Ctx
    >(
      (cmd) => Promise.resolve(`refund:${cmd.cents}`),
      (ref) => ({ type: "undo_ok", ref }),
      (err) => ({ type: "undo_err", error: String(err) }),
    ),
    unship: tryInterpret<UndoCmd & { type: "unship" }, string, Msg, Ctx>(
      (cmd) => Promise.resolve(`unship:${cmd.sku}`),
      (ref) => ({ type: "undo_ok", ref }),
      (err) => ({ type: "undo_err", error: String(err) }),
    ),
  },
});

function makeCtx(cardWorks: boolean): Ctx {
  return {
    warehouse: { reserve: (sku, qty) => Promise.resolve(`hold:${sku}x${qty}`) },
    gateway: {
      charge: (cents) =>
        cardWorks
          ? Promise.resolve(`auth:${cents}`)
          : Promise.reject(new Error("card declined")),
    },
    carrier: {
      ship: (sku, address) => Promise.resolve(`track:${sku}@${address}`),
    },
    refunds: {
      release: (sku, qty) => Promise.resolve(`released:${sku}x${qty}`),
    },
  };
}

function settled(runtime: Runtime<State, Msg>): Promise<void> {
  return new Promise((resolve) => {
    const stop = runtime.subscribe(() => {
      if (saga.isSettled(runtime.getState().saga)) {
        stop();
        resolve();
      }
    });
  });
}

async function drive(title: string, cardWorks: boolean): Promise<void> {
  console.log(`\n=== ${title} ===`);
  const runtime = await run(checkout, { ctx: makeCtx(cardWorks) }).ready;
  const done = settled(runtime);
  await runtime.dispatch({ type: "begin" });
  await done;

  const { saga: final, log } = runtime.getState();
  for (const line of log) console.log(`  ${line}`);
  console.log(`  phase: ${final.phase}`);
  console.log(
    `  ledger: ${final.items.map((it) => `${it.id}=${it.status}`).join(" ")}`,
  );
  if (final.error !== undefined) console.log(`  cause: ${String(final.error)}`);

  await runtime.stop();
}

async function main(): Promise<void> {
  await drive("happy path", true);
  await drive("charge fails -> compensate", false);
}

main();
