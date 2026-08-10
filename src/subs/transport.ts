// ---------------------------------------------------------------------------
// fromTransport — the SEAM battery.
//
// At every seam between two TEA-shaped processes (a DO ↔ its hands container,
// a SW background ↔ a content script, a parent ↔ a child runtime), there is
// the SAME hand-rolled boilerplate:
//
//   1. The inbound message stream — a Sub keyed on a phase, opened when the
//      machine enters the phase, closed when the machine leaves it.
//   2. A transport-close detector — when the underlying channel drops, a
//      single Msg is dispatched (`*_lost`). NOT a Sub the consumer
//      re-publishes; the lifetime IS the inbound Sub's lifetime.
//   3. The outbound side — a Cmd whose handler hands a value to the live
//      transport, looked up by an interpret-local handle table keyed on the
//      phase's run-identity.
//
// Every hand-rolled seam (`hands-inbound.ts`, `forwardOutbound`, the
// `client_disconnected` Msg arm, the WS handle map) is the same three
// pieces with different vocabularies. The battery bakes those three in.
//
// What the author writes:
//
//   1. The vocabulary (Inbound / Outbound types).
//   2. ONE call: `fromTransport({ name, openTransport, parseInbound, ... })`.
//
// What the author NEVER writes again:
//
//   - The `Sub` shape, the `subscribe` cell, the `cleanup` Promise dance.
//   - The transport-close → `*_lost` Msg wiring.
//   - The "find the live socket from inside an interpret handler" lookup.
//   - The keepalive / heartbeat / sequence-number ceremony (none of those
//     belong in the machine — that's Rule 9: lifetime-bound resources are
//     Subs, not state-machine cells).
//
// Host-pluggable: the battery takes a `TransportFactory`, not a concrete
// WebSocket. A Durable Object passes a workerd `WebSocket` adapter; a worker
// thread can pass a `MessagePort` adapter; an in-process test can pass a
// stub. Same battery; three different hosts.
//
// Distinct from `fromWebSocket` / `fromReconnectingWebSocket` in this same
// subpath, which own a CONCRETE `WebSocket` and are inbound-only. This battery
// is transport-agnostic and duplex: it also owns the outbound handle table, so
// a Cmd handler can reach the live channel without a hand-written registry.
//
// Strengthens invariant 4 (external events / observation enter as Subs;
// lifecycle owned by the substrate — the inbound stream, the close
// detection, AND the outbound handle are all owned by the battery's Sub
// lifecycle, not hand-driven by the consumer's cells).
// ---------------------------------------------------------------------------

import type { DepKeyedSub, Sub, SubId } from "../index";
import { structuralHash, subId } from "../index";

/**
 * Duplex transport. The host (DO, worker thread, in-process bus) constructs
 * one from whatever the platform offers. `fromTransport` does not know what
 * a WebSocket is — it knows `send`, `onMessage`, `onClose`.
 */
export interface Transport {
  /** Send a string frame. Best-effort; failures are logged at the boundary. */
  send(data: string): void;
  /**
   * Subscribe to inbound frames. Returns a cleanup that removes the listener.
   * The battery wires this in its Sub's subscribe handler; cleanup runs when
   * the phase exits (the substrate's reconcileSubs).
   */
  onMessage(listener: (data: string) => void): () => void;
  /**
   * Subscribe to a one-shot close. Returns a cleanup that removes the
   * listener. The battery dispatches `lostMsg` on close.
   */
  onClose(listener: () => void): () => void;
  /** Close the underlying channel cleanly. Called by the Sub cleanup. */
  close(): void;
}

/**
 * Factory the consumer wires to a platform-specific transport. The battery
 * passes the runtime-derived key (`runId`, or whatever identity is on the
 * phase) so per-run transports can be addressed.
 */
export type TransportFactory<K> = (key: K) => Transport;

/**
 * The Sub the battery builds. The consumer's `Sub` union includes
 * `TransportSub<TKey>` directly — no wrapping needed, the substrate
 * reconciles by `id` and `type` like any other Sub.
 */
export interface TransportSub<TKey> extends Sub<"transport"> {
  /** The phase / run identity. Stable for the lifetime of the seam. */
  readonly key: TKey;
}

export interface FromTransportOpts<TKey, Inbound, Outbound, M, Ctx> {
  /**
   * A short, stable name for this seam. The Sub id is derived from
   * `${name}:${stringify(key)}` so two seams in the same machine (e.g.
   * `hands` + `worker`) never collide.
   */
  readonly name: string;

  /**
   * Build the transport. The battery owns the lifetime; the factory is the
   * platform-specific constructor (`new WebSocket(...)` adapter on a DO,
   * `MessagePort` adapter in a worker, in-memory stub in tests).
   */
  readonly openTransport: (key: TKey, ctx: Ctx) => Transport;

  /**
   * Parse one inbound frame. The battery hands `unknown` through (boundary
   * parse is the consumer's responsibility per invariant 8). Returning
   * `null` drops the frame silently — useful for frames the seam doesn't
   * recognize at this layer (e.g. transport-level keepalive).
   */
  readonly parseInbound: (raw: string, key: TKey) => Inbound | null;

  /**
   * Map a parsed inbound to a domain Msg. Returning `null` drops the
   * dispatch (e.g. a transport-level pong that doesn't change domain state).
   */
  readonly onInbound: (inbound: Inbound, key: TKey) => M | null;

  /**
   * The Msg dispatched when the transport closes (peer gone, network
   * dropped, normal close). ONE Msg arm, not a Sub, not a heartbeat-derived
   * deadline — the transport's own close signal is the truth.
   */
  readonly lostMsg: (key: TKey) => M;

  /**
   * Serialize an outbound. Called by the Cmd handler the battery wires.
   * Pure data → string at the seam boundary.
   */
  readonly serializeOutbound: (outbound: Outbound) => string;
}

/**
 * What the battery returns: a Sub builder (for `subscriptions`), the Sub's
 * `subscribe` handler (for `subscribe.transport`), and a `send(key, outbound)`
 * helper the consumer's Cmd handler calls. Plus a `subIdFor` factory the
 * consumer can use when keying related Subs (e.g. a deadline) to the same seam
 * identity.
 */
export interface TransportBattery<TKey, Outbound, M, Ctx> {
  /**
   * Build the Sub for `subscriptions(state)`. The consumer calls this from
   * inside their `subscriptions` cell when the seam should be open.
   */
  readonly sub: (key: TKey) => TransportSub<TKey>;

  /**
   * The `subscribe.transport` handler. Drop straight into the machine's
   * `subscribe` record — the battery wires inbound + close in one shot.
   */
  readonly subscribe: (
    sub: TransportSub<TKey>,
    ctx: Ctx,
    dispatch: (msg: M) => void,
  ) => () => void;

  /**
   * Outbound send. The Cmd handler calls this; the battery's handle table
   * (built when subscribe ran) routes to the live transport. If the seam
   * is closed (no active sub), the send is dropped honestly (logged, not
   * thrown — the reducer already moved past caring, same shape as Rule 2
   * fire-and-forget Cmds).
   */
  readonly send: (key: TKey, outbound: Outbound) => void;

  /** Pre-derived subId for `(key)` — handy for deadline Subs keyed to the same seam. */
  readonly subIdFor: (key: TKey) => SubId;

  /**
   * Pair this seam with a state-gate, producing a dep-keyed Sub for the
   * machine's `subs` array. `when(state)` returns the seam's KEY when it
   * should be open, or `null` when it should be torn down. The kernel derives
   * the id from `structuralHash(key)` and reconciles the seam's lifetime — so
   * the author neither lists this Sub in a central `subscriptions(state)` nor
   * writes its id. Replaces `subscriptions: (s) => active(s) ? [hands.sub(...)] : []`
   * + `subscribe: { transport: hands.subscribe }` with one `subs` entry.
   *
   * The `source` closes over the battery's own `subscribe` (open inbound +
   * close, wire the handle table) using the same `ctx` the kernel passes every
   * Sub source.
   */
  readonly depKeyed: <S>(
    when: (state: S) => TKey | null,
  ) => DepKeyedSub<S, M, Ctx>;
}

/**
 * Build the battery. One call per seam at the machine's host file.
 *
 * @example
 *   const handsSeam = fromTransport<RunId, HandsInbound, HandsOutbound, Msg, Ctx>({
 *     name: "hands",
 *     openTransport: (runId, ctx) => ctx.openHandsWs(runId),
 *     parseInbound: (raw) => parseHandsInbound(JSON.parse(raw)),
 *     onInbound: (inbound, runId) => ({ type: "hands_said", runId, inbound }),
 *     lostMsg: (runId) => ({ type: "hands_lost", runId }),
 *     serializeOutbound: (out) => JSON.stringify(out),
 *   });
 *
 *   // In the machine:
 *   subscriptions: (state) => state.type === "auditing" ? [handsSeam.sub(state.runId)] : [],
 *   subscribe: { transport: handsSeam.subscribe },
 *
 *   // In interpret:
 *   send_hands: async (cmd) => { handsSeam.send(cmd.runId, cmd.outbound); },
 */
export function fromTransport<TKey, Inbound, Outbound, M, Ctx>(
  opts: FromTransportOpts<TKey, Inbound, Outbound, M, Ctx>,
): TransportBattery<TKey, Outbound, M, Ctx> {
  // Handle table — one live transport per key. Lives in this closure for the
  // lifetime of the battery (i.e. the machine's lifetime). Interpret-local;
  // never crosses into reducer state. The same shape as a brain's
  // `pending: Map<callId, deferred>`: imperative handles in a Map keyed on
  // run-identity, not on durable state.
  const live = new Map<string, Transport>();

  // Single-sourced on the kernel's `structuralHash`: `"1"` (string) and `1`
  // (number) render distinctly, so a key collision can't mis-route an outbound
  // send or overwrite the wrong live transport; non-JSON keys throw loudly.
  const keyString = (k: TKey): string => structuralHash(k);

  const subIdFor = (key: TKey): SubId =>
    subId(`${opts.name}:${keyString(key)}`);

  const sub = (key: TKey): TransportSub<TKey> => ({
    id: subIdFor(key),
    type: "transport",
    key,
  });

  const subscribe: TransportBattery<TKey, Outbound, M, Ctx>["subscribe"] = (
    s,
    ctx,
    dispatch,
  ) => {
    // Open the transport. The battery owns the lifetime.
    const t = opts.openTransport(s.key, ctx);
    const k = keyString(s.key);

    // ACQUIRE-AS-SUCCESS-VALUE: wire EVERYTHING first, publish to the handle
    // table last. An adapter over an already-CLOSING socket throws while
    // wiring; when `live.set` ran first, that left the transport in the table
    // with NO sub registered — so no cleanup ever ran, `send` wrote into a
    // half-wired seam with no inbound listener, and every subsequent reconcile
    // opened another one: an unbounded leak from one recoverable throw. On the
    // way out we undo exactly what we did (drop the listeners, close the
    // transport) and rethrow, so the substrate records the failure and the
    // battery holds nothing. Same discipline `defineManagedResource` states in
    // its own header — no Handle, no release.
    let offMessage: (() => void) | undefined;
    let offClose: (() => void) | undefined;
    try {
      // Wire inbound. Parse boundary lives here per invariant 8.
      offMessage = t.onMessage((raw) => {
        const parsed = opts.parseInbound(raw, s.key);
        if (parsed === null) return;
        const msg = opts.onInbound(parsed, s.key);
        if (msg === null) return;
        dispatch(msg);
      });

      // Wire close. ONE Msg arm — `*_lost`. No heartbeat, no sequence
      // numbers, no "is the peer still alive" derivation: the transport's
      // own close IS the liveness signal.
      offClose = t.onClose(() => {
        dispatch(opts.lostMsg(s.key));
      });
    } catch (err) {
      offMessage?.();
      offClose?.();
      try {
        t.close();
      } catch (closeErr) {
        // Boundary log: the wiring failure is the fact worth surfacing, and it
        // is about to be rethrown. A close that also fails must not replace it.
        console.warn(
          `[fromTransport:${opts.name}] close during failed wiring failed`,
          closeErr,
        );
      }
      throw err;
    }

    live.set(k, t);

    // Cleanup runs when the substrate's reconcileSubs leaves the phase.
    return () => {
      offMessage?.();
      offClose?.();
      live.delete(k);
      try {
        t.close();
      } catch (err) {
        // Boundary log: cleanup-time close failures are fire-and-forget
        // (Rule 2). The reducer is already past caring.
        console.warn(`[fromTransport:${opts.name}] close failed`, err);
      }
    };
  };

  return {
    sub,
    subscribe,

    send: (key, outbound) => {
      const t = live.get(keyString(key));
      if (t === undefined) {
        // Honest drop. The reducer's Cmd burst can race a `*_lost`
        // transition; the Cmd is fire-and-forget at that point.
        console.warn(
          `[fromTransport:${opts.name}] send dropped — no live transport for key`,
          keyString(key),
        );
        return;
      }
      t.send(opts.serializeOutbound(outbound));
    },

    subIdFor,

    // Dep-keyed entry: `when` is the gate (the deps slice → the seam key);
    // `source` re-runs `when(state)` to recover the typed key and opens the seam
    // via the battery's own `subscribe`. The kernel only calls `source` when
    // `deps(state)` was non-null, so `when` is non-null here; the key type never
    // escapes the entry (cast-free existential).
    depKeyed: <S>(when: (state: S) => TKey | null): DepKeyedSub<S, M, Ctx> => ({
      deps: when,
      source: (state, dispatch, ctx) => {
        const key = when(state);
        if (key === null) return () => {};
        return subscribe(sub(key), ctx, dispatch);
      },
    }),
  };
}
