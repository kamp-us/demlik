/// <reference types="@cloudflare/workers-types" />
/**
 * The CONTROL LANE — the same checkout saga written the way almost everyone
 * writes it, and deliberately NOT with tea.
 *
 * Plain async code. The status row is persisted (so a dashboard can read it),
 * but the retry ladder itself — "which attempt are we on, when is the next one
 * due, who is going to fire it" — lives entirely in one `await sleep(delay)`
 * inside one isolate's memory. That is exactly what an Effect `Schedule`, a
 * `p-retry` loop, or a hand-rolled `setTimeout` chain gives you.
 *
 * It works perfectly. Right up until the process dies. Then the persisted row
 * still says "paying, attempt 2, retrying in 5s" — forever, because the only
 * thing that was ever going to fire that retry was the stack frame that just
 * evaporated. Nothing on the outside can tell the difference between "waiting"
 * and "dead"; that ambiguity is the bug this demo is about.
 */

import {
  declinesFor,
  isRefundScenario,
  paymentRetryPolicy,
  REFUND_WAIT_MS,
  RESERVE_WAIT_MS,
  retryDelayMs,
} from "./machine";

// Shared with the tea lane so the two can never drift into an unfair race.
const MAX_ATTEMPTS = paymentRetryPolicy.maxAttempts;

export interface NaiveRow {
  readonly phase:
    | "idle"
    | "paying"
    | "reserving"
    | "refunding"
    | "settled"
    | "failed";
  readonly orderId: string;
  readonly amountCents: number;
  readonly attempt: number;
  readonly dueAt: number | null;
  readonly paymentRef: string | null;
  readonly refunded: boolean;
  readonly failure: string | null;
  readonly updatedAt: number;
  readonly log: readonly { readonly at: number; readonly text: string }[];
}

const FRESH: NaiveRow = {
  phase: "idle",
  orderId: "",
  amountCents: 0,
  attempt: 0,
  dueAt: null,
  paymentRef: null,
  refunded: false,
  failure: null,
  updatedAt: 0,
  log: [],
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class NaiveOrderDO implements DurableObject {
  /**
   * Is a retry loop running in THIS isolate right now? An instance field, so
   * it is `false` on every fresh isolate — including the one that comes up
   * after `ctx.abort()`. This is the honest "nothing is coming" signal.
   */
  #looping = false;

  constructor(
    private readonly ctx: DurableObjectState,
    _env: unknown,
  ) {}

  async #read(): Promise<NaiveRow> {
    return (await this.ctx.storage.get<NaiveRow>("row")) ?? FRESH;
  }

  async #write(row: NaiveRow): Promise<void> {
    await this.ctx.storage.put("row", row);
  }

  async #note(
    row: NaiveRow,
    text: string,
    patch: Partial<NaiveRow> = {},
  ): Promise<NaiveRow> {
    const at = Date.now();
    const next: NaiveRow = {
      ...row,
      ...patch,
      updatedAt: at,
      log: [...row.log, { at, text }].slice(-40),
    };
    await this.#write(next);
    return next;
  }

  /**
   * The whole saga as one async function. Note where the ladder lives: in the
   * `for` loop's `attempt` binding and in `await sleep(delay)`. Neither is
   * written down anywhere durable, and neither survives the isolate.
   */
  async #start(orderId: string, amountCents: number): Promise<NaiveRow> {
    this.#looping = true;
    // Land the opening row BEFORE returning, so the response to `/start`
    // describes the started order. Reading the row while the fire-and-forget
    // loop was still on its first write made `/start` answer with an empty,
    // idle order — which read as "start wiped my lanes".
    const opening = await this.#note(
      await this.#read(),
      `order ${orderId} started`,
      {
        phase: "paying",
        orderId,
        amountCents,
        // The loop charges attempt 1 immediately; saying so up front keeps the
        // two lanes reporting the same rung from the very first response.
        attempt: 1,
        dueAt: null,
        paymentRef: null,
        refunded: false,
        failure: null,
      },
    );

    const work = (async () => {
      let row = opening;
      const declines = declinesFor(orderId);

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        row = await this.#note(row, `charging (attempt ${attempt})`, {
          attempt,
          dueAt: null,
        });

        if (attempt <= declines) {
          if (attempt === MAX_ATTEMPTS) break;
          const delay = retryDelayMs(attempt);
          row = await this.#note(
            row,
            `payment attempt ${attempt} declined (issuer timeout (attempt ${attempt})) — retry in ${delay}ms`,
            { dueAt: Date.now() + delay },
          );
          // ── the retry ladder, right here, in RAM ─────────────────────────
          await sleep(delay);
          continue;
        }

        const ref = `pay_${orderId}_${amountCents}_a${attempt}`;
        row = await this.#note(
          row,
          `payment captured (${ref}) — asking the warehouse`,
          { phase: "reserving", paymentRef: ref, dueAt: null },
        );

        // ── the reservation wait, also in RAM ────────────────────────────
        row = await this.#note(
          row,
          `reserving stock… (warehouse answers in ${RESERVE_WAIT_MS}ms)`,
          { dueAt: Date.now() + RESERVE_WAIT_MS },
        );
        await sleep(RESERVE_WAIT_MS);
        row = await this.#note(row, "warehouse is answering…", { dueAt: null });

        if (!isRefundScenario(orderId)) {
          await this.#note(row, "stock reserved — order settled", {
            phase: "settled",
          });
          this.#looping = false;
          return;
        }

        row = await this.#note(
          row,
          `reservation failed (out of stock: ${orderId}) — refunding ${ref}`,
          { phase: "refunding", failure: `out of stock: ${orderId}` },
        );

        // ── and the refund wait. Every wait this lane makes is a sleep, so
        // every one of them dies with the isolate. The refund is the one that
        // actually costs someone money.
        row = await this.#note(
          row,
          `refund submitted… (clears in ${REFUND_WAIT_MS}ms)`,
          { dueAt: Date.now() + REFUND_WAIT_MS },
        );
        await sleep(REFUND_WAIT_MS);
        row = await this.#note(row, "confirming the refund…", { dueAt: null });
        await this.#note(
          row,
          "refund cleared — order failed cleanly, customer made whole",
          { phase: "failed", refunded: true },
        );
        this.#looping = false;
        return;
      }

      await this.#note(row, "payment gave up", {
        phase: "failed",
        failure: "retry budget exhausted",
        dueAt: null,
      });
      this.#looping = false;
    })();
    // `waitUntil` keeps the isolate alive across the sleeps, so the lane is a
    // FAIR comparison: uncrashed, it settles exactly like the tea lane.
    this.ctx.waitUntil(work);
    return opening;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      const orderId = url.searchParams.get("order") ?? "order-1";
      const amountCents = Number(url.searchParams.get("cents") ?? "4200");
      const row = await this.#read();
      // An explicit start always restarts, matching the tea lane's reducer —
      // except for a genuine double-click, which the tea lane also ignores.
      const recentlyStarted =
        this.#looping && Date.now() - row.updatedAt < 1_500;
      if (!recentlyStarted) {
        return json(this.#view(await this.#start(orderId, amountCents)));
      }
      return json(this.#view(row));
    }

    if (url.pathname === "/state") {
      return json(this.#view(await this.#read()));
    }

    if (url.pathname === "/reset") {
      await this.ctx.storage.deleteAll();
      this.#looping = false;
      return json(this.#view(FRESH));
    }

    if (url.pathname === "/crash") {
      this.ctx.abort("checkout-saga demo: deliberate crash");
      return json({ crashed: true });
    }

    return new Response("not found", { status: 404 });
  }

  #view(row: NaiveRow) {
    const terminal = row.phase === "settled" || row.phase === "failed";
    const inFlight = row.phase !== "idle" && !terminal;
    return {
      lane: "naive" as const,
      phase: row.phase,
      orderId: row.orderId,
      amountCents: row.amountCents,
      attempt: row.attempt,
      dueAt: row.dueAt,
      waitInMs: row.dueAt === null ? null : Math.max(0, row.dueAt - Date.now()),
      retryInMs:
        row.dueAt === null || row.phase !== "paying"
          ? null
          : Math.max(0, row.dueAt - Date.now()),
      paymentRef: row.paymentRef,
      refunded: row.refunded,
      failure: row.failure,
      terminal,
      /** Is anything actually going to advance this order? */
      loopAlive: this.#looping,
      /**
       * The row says "in flight" but no loop exists in this isolate to advance
       * it. Nobody is coming. This is the state a real on-call engineer finds
       * at 3am and cannot distinguish from "still working".
       */
      frozen: inFlight && !this.#looping,
      /**
       * WHAT was lost, in the phase it was lost in. "Frozen while paying" is a
       * customer who never gets charged; "frozen while refunding" is a customer
       * who was charged and whose money is now sitting in limbo with nothing
       * scheduled to return it. The second one is the expensive one.
       */
      strandedMoney: inFlight && !this.#looping && row.paymentRef !== null,
      lastSeenAt: row.updatedAt,
      staleForMs: row.updatedAt === 0 ? null : Date.now() - row.updatedAt,
      log: row.log,
    };
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json" },
  });
}
