// ---------------------------------------------------------------------------
// defineManagedResource — a Model-gated resource with a MANDATORY release.
//
// foldkit's ManagedResource, ported. The recurring shape: a resource whose
// lifetime is "while the machine is in phase X, hold Y open; on leaving X,
// tear Y down" — a checkpoint store, a span, a lease, a pooled connection.
// Rule 9 says that is a Sub the substrate reconciles, NOT a start/end Cmd
// pair hand-driven across cells. Hand-driving leaks: every transition cell
// has to remember to end-then-start, and one missed cell leaks the resource
// forever (the checkpoint-namespace leak this battery was built to kill).
//
// The author writes three things — `{ name, acquire, release }` — and gets
// back a `.sub(key)` to drop into `subscriptions(state)` plus a `.subscribe`
// handler to drop into the machine's `subscribe` record. The substrate's
// existing `reconcileSubs` (packages/tea/src/run.ts) does the rest:
//   - sub APPEARS in the desired set     → handler runs → `acquire(key, ctx)`.
//   - sub DISAPPEARS (phase left)        → cleanup runs → `release(handle)`.
//   - sub KEY changes (id changes)       → old cleanup (release) + new acquire.
// Same reconcile mechanism `fromTransport` rides for open/close — no new
// kernel hook.
//
// THE ACQUIRE-AS-SUCCESS-VALUE DISCIPLINE
// ----------------------------------------
// `release` receives ONLY what `acquire` returned (the Handle). Nothing else
// is in scope. So:
//   - An `acquire` that throws never produces a Handle, so `release` is never
//     called with a half-built resource — an interrupted acquire can't dangle.
//   - Whatever `release` needs to tear down must be captured INTO the Handle
//     by `acquire`. The Handle is the closure over the live resource.
// `release` is NOT optional in the type. A managed resource without a teardown
// is just a Cmd (Rule 5); the whole point of this battery is the guaranteed
// teardown, so the type forces the author to write one.
//
// NEUTRAL MECHANISM — no policy. The battery knows `acquire`, `release`,
// `name`, `key`. It does not know what a checkpoint, a span, or a socket is.
// Could a reasonable machine want the opposite of any choice here? The only
// choices are "release is mandatory" (yes — that's the contract) and "release
// runs on disappear OR key-change" (yes — that's reconcile semantics, shared
// with every other Sub). No Cloudflare, no audit domain.
//
// Strengthens invariant 4 (external lifecycle owned by the substrate — the
// acquire/release pair rides reconcileSubs, never hand-driven by a cell) and
// invariant 6 (no silent looseness — every live resource is a Sub in the
// desired set, visible in the Sub topology, and an unroutable one throws).
// ---------------------------------------------------------------------------

import type { DepKeyedSub, Sub, SubId } from "../index";
import { structuralHash, subId } from "../index";

/**
 * The Sub the battery builds. The consumer's `Sub` union includes
 * `ManagedResourceSub<TKey>` directly — the substrate reconciles by `id` and
 * `type` like any other Sub.
 */
export interface ManagedResourceSub<TKey> extends Sub<"managed_resource"> {
  /** The lifetime key. Stable while the resource should be held; a change
   *  retires the old resource (release) and acquires a fresh one. */
  readonly key: TKey;
}

/**
 * A battery paired with a state-gate. Self-contained: it knows its `name`
 * (for the unique-name assert), how to derive its live Sub from a state
 * (`subFor`), how to handle its own `subscribe`, and whether it `owns` a given
 * Sub id.
 *
 * Generic in the consumer state `S`, the shared lifetime key `TKey`, and the
 * shared `Ctx`. `Handle` is the ONLY thing erased — each battery's handle type
 * differs (a checkpoint saver vs. a tool-call bridge) but never crosses this
 * interface, so a `combineManagedResources` array holds entries of
 * heterogeneous handle types with no cast. The sub type stays
 * `ManagedResourceSub<TKey>` end to end, so the substrate's narrowed Sub flows
 * straight in.
 */
export interface GatedManagedResource<S, TKey, Ctx> {
  /** The owning battery's `name`. The combinator asserts these are unique. */
  readonly name: string;

  /**
   * Derive this resource's live Sub for a given state: the battery's
   * `.sub(key)` when `when(state)` returns a key, or `null` when it returns
   * `null` (the resource should be torn down in that state).
   */
  readonly subFor: (state: S) => ManagedResourceSub<TKey> | null;

  /**
   * This battery's own `.subscribe`. The combinator routes an incoming
   * `managed_resource` Sub to the entry whose `owns(sub)` is true, then calls
   * this.
   */
  readonly subscribe: (
    sub: ManagedResourceSub<TKey>,
    ctx: Ctx,
    dispatch: (msg: never) => void,
  ) => () => void;

  /**
   * Does this entry own the given Sub? `sub.id === subIdFor(sub.key)` encodes
   * the battery `name`, so a match is unambiguous.
   */
  readonly owns: (sub: ManagedResourceSub<TKey>) => boolean;
}

/**
 * What `combineManagedResources` returns: the single managed-resource
 * `subscribe` cell for the machine's `subscribe` record, and a `subs(state)`
 * builder for `subscriptions(state)`.
 */
export interface CombinedManagedResources<S, TKey, Ctx> {
  /**
   * Map every entry through its `when(state)`, drop the `null`s, and build the
   * live Subs. Spread into `subscriptions(state)`. The derived list and the
   * `subscribe` routing share one source — the entries — so they never drift.
   */
  readonly subs: (state: S) => ManagedResourceSub<TKey>[];

  /**
   * The SINGLE `subscribe.managed_resource` handler. Routes an incoming Sub to
   * the owning battery by matching `sub.id === battery.subIdFor(sub.key)` (the
   * id encodes the battery `name`). Throws loudly on an unrouted id — a wiring
   * bug, never a silent no-op resource.
   */
  readonly subscribe: (
    sub: ManagedResourceSub<TKey>,
    ctx: Ctx,
    dispatch: (msg: never) => void,
  ) => () => void;
}

export interface DefineManagedResourceOpts<TKey, Handle, Ctx> {
  /**
   * A short, stable name. The Sub id is `managed:${name}:${stringify(key)}`,
   * so two managed resources in one machine never collide and neither
   * collides with a `fromTransport` Sub keyed on the same identity.
   */
  readonly name: string;

  /**
   * Build the resource. Runs when the Sub appears in `subscriptions(state)`.
   * The returned Handle is the ONLY thing `release` receives — capture
   * everything teardown needs into it. If `acquire` throws, the substrate's
   * reconcile does NOT register the Sub and `release` is never called (no
   * dangling half-built resource).
   */
  readonly acquire: (key: TKey, ctx: Ctx) => Handle;

  /**
   * Tear the resource down. Runs when the Sub leaves the desired set (phase
   * exited) or when its key changes. MANDATORY — the guaranteed teardown is
   * the reason this battery exists. May be sync or async; the substrate's
   * cleanup is fire-and-forget (Rule 2), so a rejected teardown is logged at
   * the boundary, not surfaced as a Msg.
   */
  readonly release: (handle: Handle) => void | Promise<void>;
}

/**
 * What the battery returns: a `.sub(key)` builder for `subscriptions`, the
 * `.subscribe` handler for the machine's `subscribe` record, a `.get(key)`
 * accessor so Cmd handlers can reach the live Handle while the resource is
 * held, and a `.subIdFor(key)` for tests.
 */
export interface ManagedResourceBattery<TKey, Handle, Ctx> {
  /**
   * Build the Sub for `subscriptions(state)`. The consumer calls this from
   * inside their `subscriptions` cell for the phases where the resource
   * should be live.
   */
  readonly sub: (key: TKey) => ManagedResourceSub<TKey>;

  /**
   * Pair this battery with a state-gate, producing a self-contained entry for
   * `combineManagedResources`. `when(state)` returns the resource's KEY when
   * it should be live in that state, or `null` when it should be torn down.
   *
   * Folding "is it active?" and "what key?" into ONE declaration at the
   * battery's own definition site is the point: a central `subscriptions(state)`
   * list can silently forget to gate a new phase, but a per-resource gate
   * travels with the resource. The combinator derives BOTH the active-sub list
   * and the subscribe routing from these entries, so the two can never disagree.
   *
   * Generic in the consumer's state `S` (each `.gated` call binds its own `S`).
   * The returned entry erases this battery's `Handle` — `combineManagedResources`
   * holds entries of heterogeneous handle types with no cast — while keeping
   * `TKey` and `Ctx` so the substrate's narrowed `ManagedResourceSub<TKey>`
   * flows straight into the entry's `subscribe`.
   */
  readonly gated: <S>(
    when: (state: S) => TKey | null,
  ) => GatedManagedResource<S, TKey, Ctx>;

  /**
   * Dep-keyed entry for the machine's `subs` array. `when(state)` returns the
   * resource's KEY when it should be held, or `null` when it should be torn
   * down — the exact gate `.gated` takes, now producing a `DepKeyedSub` the
   * kernel folds directly instead of an entry the `combineManagedResources`
   * router multiplexes.
   *
   * This is the simplification the dep-keyed kernel unlocks: two managed
   * resources used to COLLIDE on the single `subscribe.managed_resource` key
   * (both subs share `type: "managed_resource"`), forcing
   * `combineManagedResources` to route by SubId. A dep-keyed Sub has its OWN
   * reconcile slot (its array position), so there is no shared `type` to route
   * — each resource is one `subs` entry, no combinator, no router. `acquire` /
   * `release` still ride the kernel's dispose-on-change / dispose-on-null
   * reconcile, now via the dep-keyed source's `Dispose` instead of the
   * `subscribe` cell's cleanup.
   */
  readonly depKeyed: <S>(
    when: (state: S) => TKey | null,
  ) => DepKeyedSub<S, never, Ctx>;

  /**
   * The `subscribe.managed_resource` handler. Drop straight into the
   * machine's `subscribe` record. Runs `acquire` on install, holds the
   * Handle in the battery's handle table, and returns a cleanup that runs
   * `release` (and forgets the Handle) on reconcile-out.
   */
  readonly subscribe: (
    sub: ManagedResourceSub<TKey>,
    ctx: Ctx,
    // The managed resource dispatches no Msgs — acquire/release are pure
    // lifecycle. `dispatch` is accepted to match the substrate's
    // `subscribe[type]` shape and is intentionally unused.
    dispatch: (msg: never) => void,
  ) => () => void;

  /**
   * Accessor for the live Handle, keyed on `key`. Returns `undefined` when
   * the resource is not currently held (no active sub for that key) — the
   * caller decides whether that is an error. A Cmd handler wires its
   * `ctx.getX(key)` through this, so the handler reads the SAME owner the
   * reconciler holds, never a hand-built duplicate.
   */
  readonly get: (key: TKey) => Handle | undefined;

  /** Pre-derived subId for `(key)` — handy for tests. */
  readonly subIdFor: (key: TKey) => SubId;
}

/**
 * Build the battery. One call per managed resource at the machine's host
 * file.
 *
 * @example
 *   const checkpointStore = defineManagedResource<RunId, CheckpointSaver, Ctx>({
 *     name: "checkpoint",
 *     acquire: (runId, ctx) =>
 *       new CheckpointSaver({ storage: ctx.storage, bucket: ctx.bucket, runId }),
 *     release: (saver) => saver.clear(),
 *   });
 *
 *   // In the machine:
 *   subscriptions: (state) =>
 *     state.type === "running" ? [checkpointStore.sub(state.runId)] : [],
 *   subscribe: { managed_resource: checkpointStore.subscribe },
 *
 *   // In interpret (read the live handle the reconciler holds):
 *   start_graph: async (cmd, ctx) => {
 *     const saver = checkpointStore.get(cmd.runId);  // same owner, no rebuild
 *     ...
 *   }
 */
export function defineManagedResource<TKey, Handle, Ctx>(
  opts: DefineManagedResourceOpts<TKey, Handle, Ctx>,
): ManagedResourceBattery<TKey, Handle, Ctx> {
  // Handle table — one live resource per key. Lives in this closure for the
  // lifetime of the battery (the machine's lifetime). Interpret-local; never
  // crosses into reducer state. Same shape as `fromTransport`'s `live` map.
  const held = new Map<string, Handle>();

  // Single-sourced on the kernel's `structuralHash`: `"1"` (string) and `1`
  // (number) render distinctly, so a key collision can't return/release the
  // wrong held handle; non-JSON keys throw loudly instead of silently returning
  // undefined.
  const keyString = (k: TKey): string => structuralHash(k);

  const subIdFor = (key: TKey): SubId =>
    subId(`managed:${opts.name}:${keyString(key)}`);

  const subBuilder = (key: TKey): ManagedResourceSub<TKey> => ({
    id: subIdFor(key),
    type: "managed_resource",
    key,
  });

  const subscribeHandler = (
    sub: ManagedResourceSub<TKey>,
    ctx: Ctx,
    _dispatch: (msg: never) => void,
  ): (() => void) => {
    // Acquire. A throw here propagates out of reconcileSubs (the substrate
    // records it and re-throws after the diff pass) and the Sub is NOT
    // registered — so no cleanup runs and `held` stays clean. The
    // acquire-as-success-value discipline: no Handle, no release.
    const handle = opts.acquire(sub.key, ctx);
    const k = keyString(sub.key);
    held.set(k, handle);

    // Cleanup runs when the substrate's reconcileSubs leaves the phase OR
    // the key changes. Forget the Handle first so a concurrent `get` after
    // teardown begins sees `undefined`, then release.
    return () => {
      held.delete(k);
      try {
        const result = opts.release(handle);
        if (result instanceof Promise) {
          result.catch((err) => {
            // Boundary log: teardown failures are fire-and-forget (Rule 2).
            // The reducer is already past caring (the phase was left).
            console.warn(`[managed:${opts.name}] release failed`, err);
          });
        }
      } catch (err) {
        console.warn(`[managed:${opts.name}] release threw`, err);
      }
    };
  };

  return {
    sub: subBuilder,

    // Pair the battery with a state-gate. `TKey` / `Handle` / `Ctx` are in
    // scope here, so `subFor` builds the fully-typed sub and `subscribe`
    // forwards straight to the battery's own typed `subscribe`. The entry
    // erases ONLY `Handle` for the combinator (`TKey` and `Ctx` stay), so the
    // substrate's narrowed `ManagedResourceSub<TKey>` flows in with no cast.
    gated: <S>(
      when: (state: S) => TKey | null,
    ): GatedManagedResource<S, TKey, Ctx> => ({
      name: opts.name,
      owns: (sub) => sub.id === subIdFor(sub.key),
      subFor: (state) => {
        const key = when(state);
        return key === null ? null : subBuilder(key);
      },
      subscribe: subscribeHandler,
    }),

    // Dep-keyed entry. `when` is the gate (the deps = the KEY); the source runs
    // the SAME `acquire` → hold → `release`-on-dispose lifecycle the `subscribe`
    // cell does, now driven by the kernel's dep-keyed reconcile. The Msg type is
    // `never` (a managed resource dispatches nothing); the ignored `_dispatch`
    // matches the source signature.
    depKeyed: <S>(
      when: (state: S) => TKey | null,
    ): DepKeyedSub<S, never, Ctx> => ({
      deps: when,
      source: (state, _dispatch, ctx) => {
        const key = when(state);
        if (key === null) return () => {};
        return subscribeHandler(subBuilder(key), ctx, () => {});
      },
    }),

    subscribe: subscribeHandler,

    get: (key) => held.get(keyString(key)),

    subIdFor,
  };
}

// ---------------------------------------------------------------------------
// combineManagedResources — fold N gated batteries into ONE subscribe cell + a
// derived active-sub list.
//
// Two managed resources colliding on the single `subscribe.managed_resource`
// key forced the machine to hand-roll a router (`if (sub.id === X.subIdFor(...))`).
// A third copy-pastes another `if`. That router is glue that belongs in the
// substrate, not the machine. AND the resources' active-phase gating lived in
// a central `subscriptions(state)` list a new phase could silently forget.
//
// This combinator closes both gaps. Each entry carries its OWN gate at its
// definition site (`battery.gated((s) => active(s) ? key : null)`), and the
// combinator derives BOTH the active-sub list (`subs`) and the routing
// (`subscribe`) from the same entries — so they can never disagree, and a new
// phase that the gate doesn't cover simply produces no sub (no silent leak of
// the central-list-forgot kind).
//
// NEUTRAL MECHANISM — no domain knowledge. The combinator knows `name` (for
// the unique assert), `owns` (for routing), `subFor` (for the list), and
// `subscribe` (to forward). It does not know what a checkpoint, a bridge, or a
// Cloudflare anything is.
//
// Strengthens invariant 4 (external lifecycle owned by the substrate — both
// the list and the routing are derived, never hand-driven) and invariant 6 (no
// silent looseness — ONE managed-resource cell, and an unrouted id throws
// loudly instead of silently installing a no-op).
// ---------------------------------------------------------------------------
export function combineManagedResources<S, TKey, Ctx>(
  entries: readonly GatedManagedResource<S, TKey, Ctx>[],
): CombinedManagedResources<S, TKey, Ctx> {
  // Assert unique names at construction — two batteries with the same `name`
  // collide on Sub id (`managed:${name}:${key}`), so the router could not tell
  // them apart. Throw immediately (mirrors foldkit's `combineSubscriptions` on
  // a duplicate key) rather than mis-route at runtime.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(
        `[combineManagedResources] duplicate managed-resource name "${entry.name}" — names must be unique (the Sub id encodes the name; two batteries sharing it collide)`,
      );
    }
    seen.add(entry.name);
  }

  return {
    subs: (state) => {
      const live: ManagedResourceSub<TKey>[] = [];
      for (const entry of entries) {
        const sub = entry.subFor(state);
        if (sub !== null) live.push(sub);
      }
      return live;
    },

    subscribe: (sub, ctx, dispatch) => {
      const owner = entries.find((entry) => entry.owns(sub));
      if (owner === undefined) {
        // No battery owns this managed-resource SubId — a wiring bug. Surface
        // loudly rather than silently install a no-op resource (invariant 6).
        throw new Error(
          `[combineManagedResources] no battery for sub id ${sub.id}`,
        );
      }
      return owner.subscribe(sub, ctx, dispatch);
    },
  };
}
