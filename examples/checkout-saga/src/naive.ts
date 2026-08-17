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

import { retryDelayMs } from "./machine";

/** Matches the Effect-side fake provider so both lanes fail identically. */
const FLAKY_ATTEMPTS = 2;
const MAX_ATTEMPTS = 4;

export interface NaiveRow {
  readonly phase: "idle" | "paying" | "reserving" | "settled" | "failed";
  readonly orderId: string;
  readonly amountCents: number;
  readonly attempt: number;
  readonly nextRetryAt: number | null;
  readonly paymentRef: string | null;
  readonly failure: string | null;
  readonly updatedAt: number;
  readonly log: readonly { readonly at: number; readonly text: string }[];
}

const FRESH: NaiveRow = {
  phase: "idle",
  orderId: "",
  amountCents: 0,
  attempt: 0,
  nextRetryAt: null,
  paymentRef: null,
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
  #start(orderId: string, amountCents: number): void {
    this.#looping = true;
    const work = (async () => {
      let row = await this.#read();
      row = await this.#note(row, `order ${orderId} started`, {
        phase: "paying",
        orderId,
        amountCents,
        attempt: 0,
        nextRetryAt: null,
        paymentRef: null,
        failure: null,
      });

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        row = await this.#note(row, `charging (attempt ${attempt})`, {
          attempt,
          nextRetryAt: null,
        });

        if (attempt <= FLAKY_ATTEMPTS) {
          if (attempt === MAX_ATTEMPTS) break;
          const delay = retryDelayMs(attempt);
          row = await this.#note(
            row,
            `payment attempt ${attempt} declined (issuer timeout (attempt ${attempt})) — retry in ${delay}ms`,
            { nextRetryAt: Date.now() + delay },
          );
          // ── the entire retry ladder, right here, in RAM ──────────────────
          await sleep(delay);
          continue;
        }

        const ref = `pay_${orderId}_${amountCents}_a${attempt}`;
        row = await this.#note(
          row,
          `payment captured (${ref}) — reserving stock`,
          {
            phase: "reserving",
            paymentRef: ref,
            nextRetryAt: null,
          },
        );

        if (orderId.includes("oos")) {
          row = await this.#note(
            row,
            `reservation failed (out of stock: ${orderId}) — refunding ${ref}`,
            { failure: `out of stock: ${orderId}` },
          );
          row = await this.#note(row, "refund issued — order failed cleanly", {
            phase: "failed",
          });
          this.#looping = false;
          return;
        }

        await this.#note(row, "stock reserved — settled", { phase: "settled" });
        this.#looping = false;
        return;
      }

      await this.#note(row, "payment gave up", {
        phase: "failed",
        failure: "retry budget exhausted",
        nextRetryAt: null,
      });
      this.#looping = false;
    })();
    // `waitUntil` keeps the isolate alive across the sleeps, so the lane is a
    // FAIR comparison: uncrashed, it settles exactly like the tea lane.
    this.ctx.waitUntil(work);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/start") {
      const orderId = url.searchParams.get("order") ?? "order-1";
      const amountCents = Number(url.searchParams.get("cents") ?? "4200");
      const row = await this.#read();
      if (!this.#looping && row.phase !== "reserving") {
        this.#start(orderId, amountCents);
      }
      return json(this.#view(await this.#read()));
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
      nextRetryAt: row.nextRetryAt,
      retryInMs:
        row.nextRetryAt === null
          ? null
          : Math.max(0, row.nextRetryAt - Date.now()),
      paymentRef: row.paymentRef,
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
