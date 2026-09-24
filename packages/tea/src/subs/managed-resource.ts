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
// back a `.depKeyed(when)` entry for the machine's `subs` plus a `.subscribe`
// runner for the `subscribe` table handed to `run`. The battery's `name` IS
// its Sub type, so two managed resources in one machine are two Sub types,
// each with its own runner — no router. The engine's reconcile does the rest:
//   - `when(state)` turns non-null       → runner runs → `acquire(key, ctx)`.
//   - `when(state)` goes null            → cleanup runs → `release(handle)`.
//   - the key changes (a new id)         → old cleanup (release) + new acquire.
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
// acquire/release pair rides the reconcile pass, never hand-driven by a cell)
// and invariant 6 (no silent looseness — every live resource is a running Sub,
// visible in `replay(...).subs`).
// ---------------------------------------------------------------------------

import type { DepKeyedSub, Dispose, Sub } from "../index";
import { structuralHash } from "../index";

/**
 * The running Sub of a managed resource named `N`: its `deps` is the lifetime
 * key. The consumer's Sub union (`types.sub`) includes it directly.
 */
export type ManagedResourceSub<N extends string, TKey> = Sub<N, TKey>;

export interface DefineManagedResourceOpts<
  N extends string,
  TKey,
  Handle,
  Ctx,
> {
  /**
   * A short, stable name — and the resource's Sub `type`. The machine's
   * `subscribe` table holds this battery's runner under it, so it must be
   * unique among the machine's Sub types.
   */
  readonly name: N;

  /**
   * Build the resource. Runs when the resource's `deps` turns non-null.
   * The returned Handle is the ONLY thing `release` receives — capture
   * everything teardown needs into it. If `acquire` throws, the engine does
   * NOT register the Sub and `release` is never called (no dangling
   * half-built resource).
   */
  readonly acquire: (key: TKey, ctx: Ctx) => Handle;

  /**
   * Tear the resource down. Runs when the key goes null (phase exited) or
   * changes. MANDATORY — the guaranteed teardown is the reason this battery
   * exists.
   *
   * May be sync or async, and an async one is really awaited: the promise is
   * returned to the substrate, which tracks it and drains it inside `stop()`
   * (bounded by `run({ disposeTimeoutMs })`). So `await runtime.stop()` means
   * the release finished — the reading a host evicting an isolate acts on.
   * MID-RUN teardown (a phase exit, a key change) is still fire-and-forget
   * (Rule 2): the reconcile pass is synchronous by construction, so it starts
   * the release and moves on. A rejection is never a Msg — it reaches the
   * runtime's `onError` sink under `phase: "sub-cleanup"`.
   */
  readonly release: (handle: Handle) => void | Promise<void>;
}

/**
 * What the battery returns: a `.depKeyed(when)` entry for the machine's
 * `subs`, the `.subscribe` runner for the `subscribe` table handed to `run`,
 * and a `.get(key)` accessor so Cmd handlers can reach the live Handle while
 * the resource is held.
 */
export interface ManagedResourceBattery<N extends string, TKey, Handle, Ctx> {
  /** The battery's Sub type — its `name`. */
  readonly type: N;

  /**
   * The `subs` entry. `when(state)` returns the resource's KEY when it should
   * be held, or `null` when it should be torn down. The key is the Sub's
   * `deps`, so the engine derives the id from it: an unchanged key leaves the
   * resource alone, a changed key releases the old one and acquires anew.
   * Plain JSON-compatible data only — the id hash throws on anything else.
   */
  readonly depKeyed: <S>(
    when: (state: S) => TKey | null,
  ) => DepKeyedSub<S, ManagedResourceSub<N, TKey>>;

  /**
   * The runner for this battery's Sub type — hand it to `run` as
   * `subscribe: { [battery.type]: battery.subscribe }`. Runs `acquire` on
   * start, holds the Handle in the battery's handle table, and returns a
   * cleanup that runs `release` (and forgets the Handle) on stop.
   */
  readonly subscribe: (
    sub: ManagedResourceSub<N, TKey>,
    ctx: Ctx,
    // The managed resource dispatches no Msgs — acquire/release are pure
    // lifecycle. `dispatch` is accepted to match the runner shape and is
    // intentionally unused.
    dispatch: (msg: never) => void,
  ) => Dispose;

  /**
   * Accessor for the live Handle, keyed on `key` (the author's key, never the
   * derived Sub id). Returns `undefined` when the resource is not currently
   * held — the caller decides whether that is an error. A Cmd handler wires
   * its `ctx.getX(key)` through this, so the handler reads the SAME owner the
   * reconciler holds, never a hand-built duplicate.
   */
  readonly get: (key: TKey) => Handle | undefined;
}

/**
 * Build the battery. One call per managed resource at the machine's host
 * file.
 *
 * @example
 * ```ts
 * import {
 *   defineMachine,
 *   defineManagedResource,
 *   type Interpret,
 *   type ManagedResourceSub,
 *   type Reducer,
 * } from "@demlik/tea";
 * import { run } from "@demlik/tea/promise";
 *
 * type RunId = string;
 * type State = { type: "idle" } | { type: "running"; runId: RunId };
 * type Msg = { type: "start"; runId: RunId } | { type: "stop" };
 * type Cmd = { type: "start_graph"; runId: RunId };
 * interface Ctx { readonly storage: Storage; readonly bucket: string }
 * declare class CheckpointSaver {
 *   constructor(opts: { storage: Storage; bucket: string; runId: RunId });
 *   save(step: string): Promise<void>;
 *   clear(): Promise<void>;
 * }
 * declare const update: Reducer<State, Msg, Cmd>;
 * declare const ctx: Ctx;
 *
 * const checkpointStore = defineManagedResource<"checkpoint", RunId, CheckpointSaver, Ctx>({
 *   name: "checkpoint",
 *   acquire: (runId, ctx) =>
 *     new CheckpointSaver({ storage: ctx.storage, bucket: ctx.bucket, runId }),
 *   release: (saver) => saver.clear(),
 * });
 *
 * // In the machine:
 * const machine = defineMachine({
 *   types: {
 *     model: {} as State,
 *     msg: {} as Msg,
 *     cmd: {} as Cmd,
 *     sub: {} as ManagedResourceSub<"checkpoint", RunId>,
 *     ctx: {} as Ctx,
 *   },
 *   init: (loaded) => [loaded ?? { type: "idle" }, []],
 *   update,
 *   subs: [
 *     checkpointStore.depKeyed((s: State) =>
 *       s.type === "running" ? s.runId : null,
 *     ),
 *   ],
 * });
 *
 * // In interpret (read the live handle the reconciler holds):
 * const interpret: Interpret<Msg, Cmd, Ctx> = {
 *   start_graph: async (cmd) => {
 *     const saver = checkpointStore.get(cmd.runId);  // same owner, no rebuild
 *     await saver?.save("started");
 *   },
 * };
 *
 * // At run:
 * run(machine, { ctx, interpret, subscribe: { checkpoint: checkpointStore.subscribe } });
 * ```
 */
export function defineManagedResource<N extends string, TKey, Handle, Ctx>(
  opts: DefineManagedResourceOpts<N, TKey, Handle, Ctx>,
): ManagedResourceBattery<N, TKey, Handle, Ctx> {
  // Handle table — one live resource per key. Lives in this closure for the
  // lifetime of the battery (the machine's lifetime). Interpret-local; never
  // crosses into reducer state. Same shape as `fromTransport`'s `live` map.
  // Keyed by the author's key, because `get` is called with that key and the
  // caller cannot know the derived Sub id.
  const held = new Map<string, Handle>();

  // Single-sourced on the kernel's `structuralHash`: `"1"` (string) and `1`
  // (number) render distinctly, so a key collision can't return/release the
  // wrong held handle; non-JSON keys throw loudly instead of silently returning
  // undefined.
  const keyString = (k: TKey): string => structuralHash(k);

  const subscribe = (
    sub: ManagedResourceSub<N, TKey>,
    ctx: Ctx,
    _dispatch: (msg: never) => void,
  ): Dispose => {
    // Acquire. A throw here propagates out of the reconcile pass (the engine
    // records it and re-throws after the diff) and the Sub is NOT registered
    // — so no cleanup runs and `held` stays clean. The
    // acquire-as-success-value discipline: no Handle, no release.
    const handle = opts.acquire(sub.deps, ctx);
    const k = keyString(sub.deps);
    held.set(k, handle);

    // Cleanup runs when the key goes null or changes. Forget the Handle first
    // so a concurrent `get` after teardown begins sees `undefined`, then
    // release.
    //
    // An async `release` is RETURNED, not swallowed: the substrate tracks the
    // promise and `stop()` awaits it (bounded), so `await runtime.stop()` means
    // the release finished. Attaching a `.catch` here and returning `void` was
    // the defect — a host doing `await stop(); env.evict()` dropped the isolate
    // mid-release, which is the leak this battery exists to prevent, moved to
    // shutdown. A rejection now reaches the runtime's `onError` under
    // `phase: "sub-cleanup"` instead of a `console.warn` nobody configured.
    return () => {
      held.delete(k);
      return opts.release(handle);
    };
  };

  return {
    type: opts.name,
    depKeyed: <S>(
      when: (state: S) => TKey | null,
    ): DepKeyedSub<S, ManagedResourceSub<N, TKey>> => ({
      type: opts.name,
      deps: when,
    }),
    subscribe,
    get: (key) => held.get(keyString(key)),
  };
}
