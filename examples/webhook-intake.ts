import { type Cmd, defineMachine, run } from "@demlik/tea";
import { createIntake, type IntakeState } from "@demlik/tea/idempotent-intake";

interface PaymentEvent {
  readonly id: string;
  readonly kind: "charge.succeeded";
  readonly amountCents: number;
  readonly customer: string;
}

interface Receipt {
  readonly ledgerEntry: string;
  readonly amountCents: number;
  readonly customer: string;
}

const intake = createIntake<PaymentEvent, Receipt>({
  keyOf: (event) => event.id,
  ttlMs: 24 * 60 * 60 * 1000,
});

interface State {
  intake: IntakeState<PaymentEvent, Receipt>;
  ledger: readonly string[];
  charged: Readonly<Record<string, number>>;
  delivered: number;
  absorbed: number;
  replayed: number;
}

type Msg =
  | {
      type: "webhook_received";
      event: PaymentEvent;
      at: number;
      itemId: string;
    }
  | { type: "worker_done"; key: string; receipt: Receipt; at: number };

type ProcessCmd = Cmd<"run_charge"> & {
  key: string;
  itemId: string;
  event: PaymentEvent;
  at: number;
};
type ReplayCmd = Cmd<"serve_cached"> & { key: string; receipt: Receipt };
type AppCmd = ProcessCmd | ReplayCmd;

type Sub = never;
interface Ctx {
  charge: (event: PaymentEvent) => Receipt;
}

export const webhookIntake = defineMachine<State, Msg, AppCmd, Sub, Ctx>({
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [
          {
            intake: intake.init(),
            ledger: [],
            charged: {},
            delivered: 0,
            absorbed: 0,
            replayed: 0,
          },
          [],
        ],

  update: {
    webhook_received: (s, m) => {
      const [nextIntake, intakeCmds] = intake.receive(
        s.intake,
        m.event,
        m.at,
        m.itemId,
      );
      const appCmds: AppCmd[] = intakeCmds.map((cmd) =>
        cmd.type === "intake:process"
          ? {
              type: "run_charge",
              key: cmd.key,
              itemId: cmd.itemId,
              event: cmd.payload,
              at: m.at,
            }
          : { type: "serve_cached", key: cmd.key, receipt: cmd.result },
      );
      const droppedPending =
        intakeCmds.length === 0 ? s.absorbed + 1 : s.absorbed;
      const servedFromCache = intakeCmds.some(
        (cmd) => cmd.type === "intake:replay",
      )
        ? s.replayed + 1
        : s.replayed;
      return [
        {
          ...s,
          intake: nextIntake,
          absorbed: droppedPending,
          replayed: servedFromCache,
        },
        appCmds,
      ];
    },

    worker_done: (s, m) => {
      const [nextIntake] = intake.complete(s.intake, m.key, m.receipt, m.at);
      return [
        {
          ...s,
          intake: nextIntake,
          ledger: [...s.ledger, m.receipt.ledgerEntry],
          charged: {
            ...s.charged,
            [m.receipt.customer]:
              (s.charged[m.receipt.customer] ?? 0) + m.receipt.amountCents,
          },
          delivered: s.delivered + 1,
        },
        [],
      ];
    },
  },

  interpret: {
    run_charge: async (cmd, ctx): Promise<Msg> => {
      const receipt = ctx.charge(cmd.event);
      console.log(
        `  enqueue+process  ${cmd.event.id}  →  ${receipt.ledgerEntry} ($${(receipt.amountCents / 100).toFixed(2)} for ${receipt.customer})`,
      );
      return { type: "worker_done", key: cmd.key, receipt, at: cmd.at };
    },
    serve_cached: async (cmd) => {
      console.log(
        `  replay-cached    ${cmd.key}  →  ${cmd.receipt.ledgerEntry} (no re-charge, original result served)`,
      );
    },
  },
});

async function main() {
  let serial = 0;
  const charge = (event: PaymentEvent): Receipt => {
    serial += 1;
    return {
      ledgerEntry: `LEDGER-${String(serial).padStart(3, "0")}`,
      amountCents: event.amountCents,
      customer: event.customer,
    };
  };

  const runtime = run(webhookIntake, { ctx: { charge } });
  await runtime.ready;

  const inbox: readonly { event: PaymentEvent; at: number }[] = [
    {
      event: {
        id: "evt-1",
        kind: "charge.succeeded",
        amountCents: 4200,
        customer: "acme",
      },
      at: 1_000,
    },
    {
      event: {
        id: "evt-2",
        kind: "charge.succeeded",
        amountCents: 1500,
        customer: "globex",
      },
      at: 2_000,
    },
    {
      event: {
        id: "evt-1",
        kind: "charge.succeeded",
        amountCents: 4200,
        customer: "acme",
      },
      at: 3_000,
    },
    {
      event: {
        id: "evt-3",
        kind: "charge.succeeded",
        amountCents: 9900,
        customer: "initech",
      },
      at: 4_000,
    },
  ];

  console.log("webhook intake — exactly-once over an at-least-once delivery\n");
  console.log("inbound stream (note evt-1 arrives twice):");
  for (const { event, at } of inbox) {
    console.log(
      `  t=${at}  ${event.id}  ${event.kind}  $${(event.amountCents / 100).toFixed(2)}  ${event.customer}`,
    );
  }
  console.log("\nprocessing:");

  let nextId = 0;
  for (const { event, at } of inbox) {
    nextId += 1;
    await runtime.dispatch({
      type: "webhook_received",
      event,
      at,
      itemId: `q-${nextId}`,
    });
  }

  await runtime.stop();
  const final = runtime.getState();
  console.log("\nresult:");
  console.log(`  delivered to ledger : ${final.delivered}`);
  console.log(`  duplicates replayed : ${final.replayed}`);
  console.log(`  duplicates dropped  : ${final.absorbed}`);
  console.log(`  ledger entries      : ${final.ledger.join(", ")}`);
  console.log(`  charged per customer:`);
  for (const [customer, cents] of Object.entries(final.charged)) {
    console.log(`    ${customer}: $${(cents / 100).toFixed(2)}`);
  }

  console.log(
    `\nevt-1 ran exactly once; the duplicate was dropped, never re-charged.`,
  );
  console.log(
    `${inbox.length} webhooks in → ${final.delivered} charges out → acme billed $${((final.charged.acme ?? 0) / 100).toFixed(2)}, not $84.00.`,
  );
}

main();
