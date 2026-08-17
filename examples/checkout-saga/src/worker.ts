/// <reference types="@cloudflare/workers-types" />
/**
 * The DO host + worker routes.
 *
 * One Durable Object per order id. Inside it:
 *   - `doStore` persists the saga State after every transition,
 *   - `durableTimer` turns "next payment retry is due at T" into a DO alarm,
 *   - `ManagedRuntime` (built once per instance) discharges the Effect Layer
 *     that the `toInterpret`-lowered handlers run against.
 *
 * `POST /order/crash` calls `ctx.abort()`. The isolate dies — the ManagedRuntime,
 * the in-flight fibers, everything. What survives is the persisted State and the
 * armed alarm, and that is enough for the saga to finish.
 */

import { DurableObject } from "cloudflare:workers";
import { ManagedRuntime } from "effect";
import {
  type DurableTimer,
  doStore,
  durableTimer,
} from "../../../src/do/index";
import { type Runtime, run } from "../../../src/index";
import { checkoutInterpret } from "./handlers";
import type { Msg, State } from "./machine";
import {
  checkoutMachine,
  initialState,
  isTerminal,
  parseState,
} from "./machine";
import { PAGE } from "./page";
import { CheckoutLayer } from "./services";

export interface Env {
  readonly CHECKOUT: DurableObjectNamespace;
}

type CheckoutRuntime = Runtime<State, Msg>;

export class CheckoutSaga extends DurableObject<Env> {
  #booting: Promise<CheckoutRuntime> | null = null;
  #timer: DurableTimer | null = null;
  #managed: ManagedRuntime.ManagedRuntime<
    import("./handlers").CheckoutR,
    never
  > | null = null;

  /**
   * Boot is lazy and memoized per ISOLATE, which is exactly the lifetime
   * `ctx.abort()` ends. After a crash the next request lands on a fresh
   * isolate, `#booting` is null again, and the machine rebuilds itself from
   * `doStore`.
   */
  #boot(): Promise<CheckoutRuntime> {
    if (this.#booting !== null) return this.#booting;
    this.#booting = (async () => {
      const managed = ManagedRuntime.make(CheckoutLayer);
      this.#managed = managed;
      const rt = await run(checkoutMachine(checkoutInterpret(managed)), {
        ctx: {},
        store: doStore<State>(this.ctx.storage, parseState),
        terminal: isTerminal,
      }).ready;
      this.#timer = durableTimer({
        alarm: this.ctx.storage,
        // A pure function of persisted State — which is what makes the
        // cold-wake re-arm identical to the never-evicted one.
        nextDeadline: () => rt.getState().nextRetryAt,
        onFire: async () => {
          await rt.dispatch({ type: "retry_now", at: Date.now() });
        },
      });
      // Cold-wake re-arm. A retry that came due while the isolate was dead
      // arms at a past timestamp and fires immediately.
      await this.#timer.rearm();
      return rt;
    })();
    return this.#booting;
  }

  override async alarm(): Promise<void> {
    await this.#boot();
    await this.#timer?.onAlarm();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const rt = await this.#boot();

    if (url.pathname === "/start") {
      const orderId = url.searchParams.get("order") ?? "order-1";
      const amountCents = Number(url.searchParams.get("cents") ?? "4200");
      await rt.dispatch({
        type: "start",
        orderId,
        amountCents,
        at: Date.now(),
      });
      await this.#timer?.rearm();
      return json(view(rt.getState()));
    }

    if (url.pathname === "/state") {
      return json(view(rt.getState()));
    }

    if (url.pathname === "/reset") {
      await rt.stop();
      await this.#managed?.dispose();
      await this.ctx.storage.deleteAll();
      this.#booting = null;
      this.#timer = null;
      this.#managed = null;
      return json(view(initialState()));
    }

    if (url.pathname === "/crash") {
      // The money shot. Everything in this isolate dies right here — no
      // unwinding, no teardown, no chance to flush. Only what `doStore`
      // already wrote and what `setAlarm` already armed survives.
      this.ctx.abort("checkout-saga demo: deliberate crash");
      return json({ crashed: true });
    }

    return new Response("not found", { status: 404 });
  }
}

interface StateView {
  readonly phase: string;
  readonly orderId: string;
  readonly amountCents: number;
  readonly attempt: number;
  readonly nextRetryAt: number | null;
  readonly retryInMs: number | null;
  readonly paymentRef: string | null;
  readonly failure: string | null;
  readonly terminal: boolean;
  readonly log: readonly { readonly at: number; readonly text: string }[];
}

function view(state: State): StateView {
  return {
    phase: state.phase,
    orderId: state.orderId,
    amountCents: state.amountCents,
    attempt: state.attempt,
    nextRetryAt: state.nextRetryAt,
    retryInMs:
      state.nextRetryAt === null
        ? null
        : Math.max(0, state.nextRetryAt - Date.now()),
    paymentRef: state.paymentRef,
    failure: state.failure,
    terminal: isTerminal(state),
    log: state.log,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (!url.pathname.startsWith("/order/")) {
      return new Response("not found", { status: 404 });
    }

    const orderId = url.searchParams.get("order") ?? "order-1";
    const stub = env.CHECKOUT.get(env.CHECKOUT.idFromName(orderId));
    const inner = new URL(url);
    inner.pathname = url.pathname.replace(/^\/order/, "");

    try {
      return await stub.fetch(new Request(inner.toString(), request));
    } catch (error) {
      // `ctx.abort()` tears the object down mid-request, so the RPC to it
      // fails by design. That failure IS the successful crash.
      if (inner.pathname === "/crash") {
        return new Response(
          JSON.stringify({ crashed: true, order: orderId }, null, 2),
          { headers: { "content-type": "application/json" } },
        );
      }
      throw error;
    }
  },
};
