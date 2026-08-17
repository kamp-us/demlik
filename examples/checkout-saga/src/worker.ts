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
import { RECIPES_PAGE } from "./recipes/page";
import { CheckoutLayer } from "./services";

export interface Env {
  /** Lane B — the tea machine. */
  readonly CHECKOUT: DurableObjectNamespace;
  /** Lane A — the same saga written the ordinary way. */
  readonly NAIVE: DurableObjectNamespace;
  /** One class, any recipe, keyed `recipe:<id>:<instance>`. */
  readonly RECIPE: DurableObjectNamespace;
}

export { NaiveOrderDO } from "./naive";
export { RecipeDO } from "./recipes/do";

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
   *
   * A FAILED boot is not memoized. Caching the rejected promise turned one bad
   * boot into a permanently poisoned object — every later request re-awaited
   * the same rejection and the DO answered 503 until the runtime recycled the
   * isolate. Clearing the slot on failure makes the next request retry.
   */
  #boot(): Promise<CheckoutRuntime> {
    if (this.#booting !== null) return this.#booting;
    const booting = (async () => {
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
        nextDeadline: () => rt.getState().dueAt,
        onFire: async () => {
          await rt.dispatch({ type: "tick", at: Date.now() });
        },
      });
      // Cold-wake re-arm. A retry that came due while the isolate was dead
      // arms at a past timestamp and fires immediately.
      await this.#timer.rearm();
      return rt;
    })();
    this.#booting = booting;
    booting.catch(() => {
      // Let the next request try again instead of inheriting this failure.
      if (this.#booting === booting) this.#booting = null;
    });
    return booting;
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
  readonly lane: "tea";
  readonly phase: string;
  readonly orderId: string;
  readonly amountCents: number;
  readonly attempt: number;
  readonly dueAt: number | null;
  /** Time left in the CURRENT wait, whatever phase it belongs to. */
  readonly waitInMs: number | null;
  /** Same number, but only while the wait is a payment retry. */
  readonly retryInMs: number | null;
  readonly paymentRef: string | null;
  readonly refunded: boolean;
  readonly failure: string | null;
  readonly terminal: boolean;
  /**
   * Always true for this lane, and that is the whole point: the thing that
   * advances the order is a persisted alarm, so it is alive by definition —
   * there is no isolate for it to have died with.
   */
  readonly loopAlive: boolean;
  readonly frozen: boolean;
  readonly strandedMoney: boolean;
  readonly lastSeenAt: number;
  readonly staleForMs: number | null;
  readonly log: readonly { readonly at: number; readonly text: string }[];
}

function view(state: State): StateView {
  const lastSeenAt = state.log.at(-1)?.at ?? 0;
  return {
    lane: "tea",
    phase: state.phase,
    orderId: state.orderId,
    amountCents: state.amountCents,
    attempt: state.attempt,
    dueAt: state.dueAt,
    waitInMs:
      state.dueAt === null ? null : Math.max(0, state.dueAt - Date.now()),
    retryInMs:
      state.dueAt === null || state.phase !== "paying"
        ? null
        : Math.max(0, state.dueAt - Date.now()),
    paymentRef: state.paymentRef,
    refunded: state.refunded,
    failure: state.failure,
    terminal: isTerminal(state),
    loopAlive: true,
    frozen: false,
    strandedMoney: false,
    lastSeenAt,
    staleForMs: lastSeenAt === 0 ? null : Date.now() - lastSeenAt,
    log: state.log,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json" },
  });
}

type Lane = "tea" | "naive";

/**
 * One lane call. `ctx.abort()` tears the object down mid-request, so the RPC
 * to it fails BY DESIGN — that failure is the successful crash, not an error.
 */
async function callLane(
  env: Env,
  lane: Lane,
  orderId: string,
  action: string,
  search: URLSearchParams,
): Promise<unknown> {
  const ns = lane === "tea" ? env.CHECKOUT : env.NAIVE;
  const stub = ns.get(ns.idFromName(orderId));
  const inner = new URL(`https://lane/${action}`);
  inner.search = search.toString();
  try {
    const res = await stub.fetch(
      new Request(inner.toString(), { method: "POST" }),
    );
    return await res.json();
  } catch (error) {
    // `crashedAt` on the client is derived from this: the worker's clock is the
    // same clock that stamps the event log, so the feed divider lands exactly
    // between the last pre-crash event and the first post-crash one — which
    // anchoring on "newest event I had polled" could not guarantee.
    if (action === "crash") {
      return { crashed: true, lane, order: orderId, at: Date.now() };
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return new Response(PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/recipes") {
      return new Response(RECIPES_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // ── the recipe panels ───────────────────────────────────────────────────
    const recipeRoute = /^\/recipe\/(state|act|crash|reset)$/.exec(
      url.pathname,
    );
    if (recipeRoute !== null) {
      const action = recipeRoute[1] as string;
      const recipe = url.searchParams.get("recipe") ?? "";
      const instance = url.searchParams.get("inst") ?? "1";
      const name = `recipe:${recipe}:${instance}`;
      const stub = env.RECIPE.get(env.RECIPE.idFromName(name));
      const inner = new URL(
        `https://recipe/${action === "state" ? "act" : action}`,
      );
      inner.search = url.searchParams.toString();
      try {
        const res = await stub.fetch(
          new Request(inner.toString(), { method: "POST" }),
        );
        return new Response(await res.text(), {
          status: res.status,
          headers: { "content-type": "application/json" },
        });
      } catch (error) {
        // `ctx.abort()` tears the object down mid-request by design.
        if (action === "crash") {
          return json({ crashed: true, recipe, instance, at: Date.now() });
        }
        throw error;
      }
    }

    const orderId = url.searchParams.get("order") ?? "order-1";
    const search = url.searchParams;

    // `/both/<action>` fans out to BOTH lanes — one explosion, two victims.
    const both = /^\/both\/(start|state|crash|reset)$/.exec(url.pathname);
    if (both !== null) {
      const action = both[1] as string;
      const [tea, naive] = await Promise.all([
        callLane(env, "tea", orderId, action, search),
        callLane(env, "naive", orderId, action, search),
      ]);
      return json({ order: orderId, tea, naive });
    }

    const single = /^\/(order|naive)\/(start|state|crash|reset)$/.exec(
      url.pathname,
    );
    if (single !== null) {
      const lane: Lane = single[1] === "naive" ? "naive" : "tea";
      const body = await callLane(
        env,
        lane,
        orderId,
        single[2] as string,
        search,
      );
      return json(body);
    }

    return new Response("not found", { status: 404 });
  },
};
