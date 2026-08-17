/// <reference types="@cloudflare/workers-types" />
/**
 * ONE Durable Object class that hosts ANY of the five recipes, keyed
 * `recipe:<id>:<instance>`. Which machine it runs is decided by the id in its
 * own name, so adding a recipe never means adding a DO class or a migration.
 *
 * Two host concerns live here and nowhere else:
 *
 *   - **The virtual clock.** Every recipe is pure over `now` — the reducer
 *     receives `at` on the Msg and never reads a clock. So the ⏩ buttons work
 *     by moving a persisted `skewMs` forward to the next deadline and
 *     dispatching the tick the alarm would have delivered. Because the skew is
 *     persisted, everything the panel does afterwards stays on the same
 *     timeline: approve something "four days later" and the audit log says four
 *     days later. In production there is no skew — the ⏩ buttons are alarms.
 *
 *   - **The event feed.** The recipes each keep their own shaped state, so the
 *     host asks the adapter for a flat `narrative()` and appends whatever is NEW
 *     since the last dispatch, stamped with the virtual instant of that
 *     dispatch. The feed is persisted, so it survives `ctx.abort()` and the
 *     crash divider has something to sit between.
 */

import { type DurableTimer, durableTimer } from "../../../../src/do/index";
import { findRecipe, type RecipeInstance } from "./registry";

const SKEW_KEY = "@@skew";
const FEED_KEY = "@@feed";
const MAX_FEED = 60;

export interface FeedLine {
  readonly at: number;
  readonly text: string;
}

interface Booted {
  readonly recipeId: string;
  readonly instance: RecipeInstance;
  readonly timer: DurableTimer;
}

export class RecipeDO implements DurableObject {
  #booting: Promise<Booted> | null = null;
  #skewMs = 0;
  #feed: FeedLine[] = [];

  constructor(
    private readonly ctx: DurableObjectState,
    _env: unknown,
  ) {}

  /** The clock every dispatch uses. Real time plus however far we've skipped. */
  #now(): number {
    return Date.now() + this.#skewMs;
  }

  #boot(recipeId: string): Promise<Booted> {
    if (this.#booting !== null) return this.#booting;
    const booting = (async () => {
      const adapter = findRecipe(recipeId);
      if (adapter === undefined) throw new Error(`unknown recipe ${recipeId}`);

      this.#skewMs = (await this.ctx.storage.get<number>(SKEW_KEY)) ?? 0;
      this.#feed = (await this.ctx.storage.get<FeedLine[]>(FEED_KEY)) ?? [];

      const instance = await adapter.boot(this.ctx.storage);

      const timer = durableTimer({
        alarm: this.ctx.storage,
        // A pure function of persisted state — which is what makes a cold-wake
        // re-arm identical to the never-evicted one. Skew-shifted back to real
        // time, because the alarm fires on the platform's clock, not ours.
        nextDeadline: () => {
          const due = instance.dueAt();
          return due === null ? null : due - this.#skewMs;
        },
        onFire: async () => {
          await instance.apply("skip", this.#now());
          await this.#absorb(this.#now());
        },
      });
      await timer.rearm();
      return { recipeId, instance, timer };
    })();
    this.#booting = booting;
    booting.catch(() => {
      // Never memoize a failed boot — that turns one bad boot into a
      // permanently 503-ing object.
      if (this.#booting === booting) this.#booting = null;
    });
    return booting;
  }

  /**
   * Append whatever the adapter's narrative says that the feed has not recorded
   * yet, stamped `at`.
   *
   * Matching on CONTENT rather than on index is load-bearing. Some adapters
   * derive their narrative freshly from current state rather than appending to
   * an array — fleet-reconcile's "2 push attempts failed" replaces "1 push
   * attempt failed" at the same position, and dunning's grace line gives way to
   * its downgrade line. An index diff sees no growth and silently drops the new
   * line while leaving the stale one on screen. A content diff appends the new
   * line and keeps the old one as history, which is what a feed should do.
   */
  async #absorb(at: number): Promise<void> {
    const booted = await this.#booting;
    if (booted === null || booted === undefined) return;
    const already = new Set(this.#feed.map((line) => line.text));
    for (const text of booted.instance.narrative()) {
      if (!already.has(text)) {
        this.#feed.push({ at, text });
        already.add(text);
      }
    }
    if (this.#feed.length > MAX_FEED) {
      this.#feed = this.#feed.slice(this.#feed.length - MAX_FEED);
    }
    await this.ctx.storage.put(FEED_KEY, this.#feed);
  }

  async alarm(): Promise<void> {
    const recipeId = await this.ctx.storage.get<string>("@@recipe");
    if (recipeId === undefined) return;
    const booted = await this.#boot(recipeId);
    await booted.timer.onAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const recipeId = url.searchParams.get("recipe") ?? "";

    if (url.pathname === "/crash") {
      // Everything in this isolate dies right here. What survives is the
      // persisted machine state, the feed, the skew, and the armed alarm.
      this.ctx.abort("recipes demo: deliberate crash");
      return json({ crashed: true });
    }

    if (url.pathname === "/reset") {
      const booted = await this.#booting;
      if (booted) await booted.instance.stop();
      await this.ctx.storage.deleteAll();
      this.#booting = null;
      this.#skewMs = 0;
      this.#feed = [];
      return json({ reset: true });
    }

    await this.ctx.storage.put("@@recipe", recipeId);
    const booted = await this.#boot(recipeId);

    if (url.pathname === "/act") {
      const action = url.searchParams.get("action") ?? "";
      // A ⏩ button moves the whole timeline forward to the deadline it names,
      // so every later action stays on the same story.
      if (action === "skip") {
        const due = booted.instance.dueAt();
        if (due !== null) {
          const jump = due - this.#now();
          if (jump > 0) {
            this.#skewMs += jump;
            await this.ctx.storage.put(SKEW_KEY, this.#skewMs);
          }
        }
      }
      const at = this.#now();
      await booted.instance.apply(action, at);
      await this.#absorb(at);
      await booted.timer.rearm();
    }

    return json(await this.#view(booted));
  }

  async #view(booted: Booted) {
    const { instance } = booted;
    const due = instance.dueAt();
    const now = this.#now();
    const lastSeenAt = this.#feed.at(-1)?.at ?? 0;
    return {
      recipe: booted.recipeId,
      phase: instance.phase(),
      terminal: instance.terminal(),
      dueAt: due,
      waitInMs: due === null ? null : Math.max(0, due - now),
      /** How far the ⏩ buttons have moved this instance's clock. */
      skewMs: this.#skewMs,
      virtualNow: now,
      facts: instance.facts(),
      chips: instance.chips(),
      actions: instance.actions(),
      log: this.#feed,
      lastSeenAt,
      staleForMs: lastSeenAt === 0 ? null : now - lastSeenAt,
    };
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json" },
  });
}
