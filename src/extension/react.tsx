/**
 * React adapters for the background TEA runtime.
 *
 * Two layers, both built on the same `bridgeClient`:
 *
 *   1. `useBackgroundRuntime(opts)` — direct hook. One bridge client per
 *      call. Surfaces that only have a single consumer mount it inline.
 *
 *   2. `createBackgroundRuntimeContext<S, M>()` → `{ Provider, useDispatch,
 *      useState, useRuntime }` — factory-style React context. Mounts the
 *      bridge client ONCE inside the Provider; child hooks read `state` /
 *      `dispatch` from context. Surfaces that drill `dispatch` through
 *      multiple component layers, or mount `useBackgroundRuntime` more
 *      than once for the same channel, should use this instead.
 *
 * Why a factory (not a single global context):
 *   - Type safety: each app types it against its own `S` / `M`.
 *   - Tests can mount fresh contexts per test (no module-level state to
 *     reset).
 *   - Multiple-runtimes case: an app COULD theoretically have two
 *     background-shaped runtimes (e.g. one per channel); the factory
 *     pattern doesn't preclude it.
 *
 * Hook lifecycle (`useBackgroundRuntime`) — preserved from the prior
 * single-export module:
 *   1. `useSyncExternalStore` subscribes to broadcasts via
 *      `bridgeClient.subscribe`, reading the latest state via
 *      `bridgeClient.getSnapshot`. Reference stability is owned by the
 *      bridge — `getSnapshot` returns the SAME `S` until a new broadcast
 *      overwrites it, so React doesn't loop.
 *   2. A one-shot `hydrate()` call seeds `latestState` before the first
 *      broadcast arrives. The hydrate side-effect runs in an effect so the
 *      first render shows `null` and the subsequent render flips to the
 *      hydrated snapshot (or stays null if the host is still booting).
 *   3. `dispatch(msg)` sends `:dispatch` envelopes.
 *
 * On unmount: `useSyncExternalStore` removes the listener; the host's
 * bridge stays installed.
 *
 * Canon §3.1: React adapters use `useSyncExternalStore`, not
 * `useState + useEffect`. `useMachine` and `useRuntime` already follow this
 * — `useBackgroundRuntime` (and by extension the Provider) does too. One
 * Way to Do Each Thing.
 *
 * NOTE: This is a separate entry from the main `index.ts` so apps that
 * never need React don't drag react into their type graph. The React
 * adapter peer-depends on react (you must have it installed in the app).
 */

"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { bridgeClient, passThroughMsg } from "./bridge";

export interface UseBackgroundRuntimeOpts<S> {
  channel: string;
  /**
   * REQUIRED parse for inbound `state` payloads. Forwarded to
   * `bridgeClient` — see `BridgeClientOpts.parseState`. Surfaces own this
   * because the chrome.runtime boundary is `unknown` (Inv 8). Returning
   * `null` drops the payload silently.
   */
  parseState: (raw: unknown) => S | null;
}

export interface UseBackgroundRuntimeResult<S, M> {
  /** Latest snapshot from the host. `null` until the first hydrate response
   * or the first broadcast arrives. Surfaces SHOULD render a placeholder
   * for the null window. */
  state: S | null;
  /** Send a msg to the host runtime. Resolves once the host's dispatch
   * settles. */
  dispatch(msg: M): Promise<void>;
}

export function useBackgroundRuntime<S, M extends { type: string }>({
  channel,
  parseState,
}: UseBackgroundRuntimeOpts<S>): UseBackgroundRuntimeResult<S, M> {
  // Pin the client across renders. Identity must be stable because
  // `useSyncExternalStore` deduplicates subscribe by reference; rebuilding
  // the client every render would re-register listeners every render too.
  const clientRef = useRef<ReturnType<typeof bridgeClient<S, M>> | null>(null);
  if (clientRef.current === null) {
    // This hook surfaces only `state`; the broadcast msg is unused, so it
    // explicitly opts out of msg parsing via `passThroughMsg`. Same behavior
    // as the former optional-`parseMsg` default, now a visible decision.
    clientRef.current = bridgeClient<S, M>({
      channel,
      parseState,
      parseMsg: passThroughMsg,
    });
  }
  const client = clientRef.current;

  const state = useSyncExternalStore<S | null>(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );

  // One-shot hydrate on mount. The hydrate response primes `getSnapshot`
  // before the first broadcast lands so newly-opened surfaces show the
  // right view immediately. We don't read its return value — the hook
  // re-renders when `useSyncExternalStore` notices the snapshot change.
  // Hydrate failures (host not present yet) are swallowed; surfaces wait
  // for the next broadcast.
  useEffect(() => {
    client.hydrate().catch(() => {
      // No host yet. Surfaces fall back to broadcasts.
    });
  }, [client]);

  const dispatch = useCallback(
    async (msg: M): Promise<void> => {
      await client.dispatch(msg);
    },
    [client],
  );

  return { state, dispatch };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider + consumer hooks — factory-style React context.
//
// `createBackgroundRuntimeContext<S, M>()` returns a `{ Provider, useDispatch,
// useState, useRuntime }` tuple bound to the caller's `S` / `M`. The
// Provider mounts `useBackgroundRuntime(opts)` ONCE internally and shares
// the `{ state, dispatch }` pair via context. Child consumers (anywhere in
// the tree) read the slice they need — no prop drilling, single bridge
// client per channel per Provider mount.
//
// The factory is generic; the returned hooks throw a clear error if used
// outside the Provider so the failure mode is "loud and obvious" rather
// than "silently returns null state forever".
// ─────────────────────────────────────────────────────────────────────────────

export interface BackgroundRuntimeContext<S, M> {
  /**
   * Wrap a subtree to share a single background-runtime bridge client.
   * `opts` is forwarded verbatim to `useBackgroundRuntime` — same channel,
   * same parse contract.
   */
  Provider: (props: {
    opts: UseBackgroundRuntimeOpts<S>;
    children: ReactNode;
  }) => ReactNode;
  /**
   * Returns the dispatch function bound to this Provider's bridge client.
   * Reference is stable across renders (per `useBackgroundRuntime`'s
   * `useCallback`), so passing it to memoized children won't churn them.
   */
  useDispatch: () => (msg: M) => Promise<void>;
  /**
   * Returns a slice of the latest state. `selector` defaults to identity
   * (returns the whole `S | null` snapshot). Selectors run on every state
   * change — surfaces with expensive transforms should memoize the
   * selector at call site.
   *
   * Returns `null` until the first hydrate / broadcast lands when the
   * selector is identity; for non-identity selectors the return type is
   * `T` and the caller's selector decides how to handle the pre-hydrate
   * `null` snapshot.
   */
  useState: {
    (): S | null;
    <T>(selector: (state: S | null) => T): T;
  };
  /**
   * Escape hatch — returns the full `{ state, dispatch }` pair as-is.
   * Useful for consumers that want both the snapshot and the dispatch
   * fn in a single hook call (e.g. effects that read state THEN
   * dispatch in response).
   *
   * Not a `@demlik/tea` `Runtime<S, M>` — the bridge surface is a thinner
   * client. This hook returns the same shape as `useBackgroundRuntime`,
   * just sourced from context instead of mounting a fresh client.
   */
  useRuntime: () => UseBackgroundRuntimeResult<S, M>;
}

const PROVIDER_ERROR =
  "createBackgroundRuntimeContext: hook used outside its Provider. Wrap the consumer in <BackgroundRuntime.Provider opts={...}>.";

export function createBackgroundRuntimeContext<
  S,
  M extends { type: string },
>(): BackgroundRuntimeContext<S, M> {
  // `null` is the "not inside a Provider" sentinel — the hooks below
  // throw on read. Distinct from `state: null` (pre-hydrate), which IS a
  // valid context value.
  const Ctx = createContext<UseBackgroundRuntimeResult<S, M> | null>(null);

  function Provider({
    opts,
    children,
  }: {
    opts: UseBackgroundRuntimeOpts<S>;
    children: ReactNode;
  }): ReactNode {
    const result = useBackgroundRuntime<S, M>(opts);
    // Stabilize the context value reference so consumers that subscribe via
    // `useContext` don't re-render unless `state` or `dispatch` actually
    // changes. `state` is reference-stable (bridge's `getSnapshot` returns
    // the same `S` until a new broadcast). `dispatch` is stable per
    // `useBackgroundRuntime`'s `useCallback`. So `useMemo` keyed on both
    // gives a stable value object across renders.
    const value = useMemo<UseBackgroundRuntimeResult<S, M>>(
      () => ({ state: result.state, dispatch: result.dispatch }),
      [result.state, result.dispatch],
    );
    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  }

  function useRuntime(): UseBackgroundRuntimeResult<S, M> {
    const ctx = useContext(Ctx);
    if (ctx === null) throw new Error(PROVIDER_ERROR);
    return ctx;
  }

  function useDispatch(): (msg: M) => Promise<void> {
    return useRuntime().dispatch;
  }

  // Two-overload `useState` so callers see `S | null` without passing a
  // selector and `T` when they do. The runtime body collapses them — if
  // `selector` is omitted we pass identity through.
  function useStateHook(): S | null;
  function useStateHook<T>(selector: (state: S | null) => T): T;
  function useStateHook<T>(selector?: (state: S | null) => T): T | (S | null) {
    const { state } = useRuntime();
    if (selector === undefined) return state;
    return selector(state);
  }

  return {
    Provider,
    useDispatch,
    useState: useStateHook,
    useRuntime,
  };
}
