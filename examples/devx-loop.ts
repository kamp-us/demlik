/**
 * The payoff you can't `npm i`: record a prod Msg trace, replay it against ANY
 * reducer version locally, and get the exact diverging field — plus a diagram.
 *
 * Story: an order machine ships v1 with a double-discount bug. Prod records the
 * trace. A dev reproduces the bug locally from the trace (no prod access), then
 * proves the v2 fix changes behavior at exactly one field and nowhere else.
 *
 * Run it:  node packages/tea/examples/devx-loop.ts   (Node 23 strips types)
 */

import { type Cmd, defineMachine, noop, run, type Sub } from "@demlik/tea";
import { toMermaid } from "@demlik/tea/machine-viz";
import { parseJSONL, recorder } from "@demlik/tea/recorder";
import { replayTrace } from "@demlik/tea/trace-replay";

// === Domain: an order that can take items + a discount, then check out ===
type Order =
  | { type: "open"; subtotal: number; discountPct: number }
  | {
      type: "checked_out";
      subtotal: number;
      discountPct: number;
      total: number;
    };

type Msg =
  | { type: "add_item"; price: number }
  | { type: "apply_discount"; pct: number }
  | { type: "checkout" };

type NoCmd = Cmd<never>;
type NoSub = Sub<never>;
type NoCtx = Record<string, never>;

const init = (loaded: Order | null): readonly [Order, readonly NoCmd[]] => [
  loaded ?? { type: "open", subtotal: 0, discountPct: 0 },
  [],
];

// --- v1: SHIPPED WITH A BUG. apply_discount discounts the subtotal in place,
//     then checkout discounts again -> the customer is double-discounted. ---
const orderV1 = defineMachine<Order, Msg, NoCmd, NoSub, NoCtx>({
  init,
  update: {
    open: {
      add_item: (s, m) => [{ ...s, subtotal: s.subtotal + m.price }, []],
      // BUG: mutates subtotal here AND records the pct.
      apply_discount: (s, m) => [
        { ...s, discountPct: m.pct, subtotal: s.subtotal * (1 - m.pct / 100) },
        [],
      ],
      checkout: (s) => [
        {
          type: "checked_out",
          subtotal: s.subtotal,
          discountPct: s.discountPct,
          total: s.subtotal * (1 - s.discountPct / 100),
        },
        [],
      ],
    },
    checked_out: { add_item: noop, apply_discount: noop, checkout: noop },
  },
});

// --- v2: THE FIX. apply_discount only records the pct; checkout applies once. ---
const orderV2 = defineMachine<Order, Msg, NoCmd, NoSub, NoCtx>({
  init,
  update: {
    open: {
      add_item: (s, m) => [{ ...s, subtotal: s.subtotal + m.price }, []],
      apply_discount: (s, m) => [{ ...s, discountPct: m.pct }, []], // fixed: just record
      checkout: (s) => [
        {
          type: "checked_out",
          subtotal: s.subtotal,
          discountPct: s.discountPct,
          total: s.subtotal * (1 - s.discountPct / 100),
        },
        [],
      ],
    },
    checked_out: { add_item: noop, apply_discount: noop, checkout: noop },
  },
});

const line = (label: string) =>
  console.log(`\n━━ ${label} ${"━".repeat(Math.max(0, 56 - label.length))}`);

async function main() {
  // === 1. IN PROD: run v1, record everything via observe ===
  line("1. IN PROD — running order machine v1");
  const runtime = run(orderV1, { ctx: {} });
  const rec = recorder(runtime);
  await runtime.ready;

  await runtime.dispatch({ type: "add_item", price: 100 });
  await runtime.dispatch({ type: "add_item", price: 50 });
  await runtime.dispatch({ type: "apply_discount", pct: 10 });
  await runtime.dispatch({ type: "checkout" });

  const prod = runtime.getState() as Extract<Order, { type: "checked_out" }>;
  console.log(
    "dispatched: add_item 100, add_item 50, apply_discount 10%, checkout",
  );
  console.log("prod final:", prod);
  console.log(
    `⚠  customer charged ${prod.total.toFixed(2)} on a 150 cart at 10% off — discount applied TWICE`,
  );

  // === 2. recorder captured the exact Msg sequence (portable JSONL) ===
  line("2. recorder captured the trace (JSONL — paste from a prod log)");
  const jsonl = rec.toJSONL();
  console.log(jsonl);
  rec.stop();

  // === 3. DEBUG LOCALLY: replay the prod trace against v1 — no prod access ===
  line("3. DEBUG — replay the prod trace against v1");
  const trace = parseJSONL<Order, Msg>(jsonl);
  const onV1 = replayTrace(orderV1, trace, {});
  console.log(
    `replayTrace(v1)  matches: ${onV1.matches}  → bug reproduced locally, deterministically`,
  );

  // === 4. VERIFY THE FIX: same trace, v2 reducer — pinpoint what changed ===
  line("4. VERIFY THE FIX — replay the SAME trace against v2");
  const onV2 = replayTrace(orderV2, trace, {});
  console.log(`replayTrace(v2)  matches: ${onV2.matches}`);
  if (onV2.divergence) {
    const d = onV2.divergence;
    console.log(`divergence at  ${d.path}`);
    console.log(
      `   prod/v1 = ${JSON.stringify(d.expected)}   v2/fixed = ${JSON.stringify(d.actual)}`,
    );
    console.log(
      "→ the fix stops v1 from corrupting that field. One field changed, nothing else.",
    );
  }

  // === 5. machine-viz: the fixed machine as a Mermaid state diagram ===
  line("5. machine-viz — the fixed machine, free");
  console.log(
    toMermaid(orderV2, {
      title: "order (v2)",
      samples: {
        states: {
          open: { type: "open", subtotal: 150, discountPct: 10 },
          checked_out: {
            type: "checked_out",
            subtotal: 150,
            discountPct: 10,
            total: 135,
          },
        },
        msgs: {
          add_item: { type: "add_item", price: 10 },
          apply_discount: { type: "apply_discount", pct: 10 },
          checkout: { type: "checkout" },
        },
      },
    }),
  );

  await runtime.stop();
}

main();
