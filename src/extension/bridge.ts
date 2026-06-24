/**
 * Runtime bridge — expose a `@demlik/tea` runtime running in one chrome context
 * (typically the background service worker) to consumers in other contexts
 * (sidepanel, popup, devtools panel) over `chrome.runtime.sendMessage` /
 * `chrome.runtime.onMessage`.
 *
 * Two halves, one channel name string.
 *
 *   ┌──── background (host) ────┐               ┌──── react surface ────┐
 *   │ bridgeRuntime(rt, {ch})   │  chrome.*     │ useBackgroundRuntime  │
 *   │  ├ observe → broadcast     │ ──────────▶  │  ├ hydrate (initial)  │
 *   │  └ onMessage(":dispatch") │ ◀──────────  │  └ dispatch (msgs)    │
 *   │  └ onMessage(":hydrate")  │               │                       │
 *   └────────────────────────────┘               └───────────────────────┘
 *
 * Wire-shape (single `channel` string, three messages):
 *
 *   { type: channel,                msg, state }   // background → surfaces (broadcast)
 *   { type: `${channel}:hydrate`  }                 // surface → background (request)
 *   { type: `${channel}:dispatch`, msg }            // surface → background (input)
 *
 * The `:hydrate` reply is the current `runtime.getState()` snapshot —
 * lets a newly-opened surface render the right view BEFORE the next
 * transition broadcast arrives.
 *
 * The bridge is intentionally agnostic to `chrome.runtime.sendMessage`
 * failure modes (no receiver, sender gone, etc.) — every cross-context send
 * is fire-and-forget with `.catch(() => {})`. Surfaces that need
 * delivery guarantees should layer their own retry, not bake it here.
 */

import { type HistoryTracker, historyTracker, type Runtime } from "../index";

// ─────────────────────────────────────────────────────────────────────────────
// Wire types — internal. Consumers don't import these directly; they pick
// the channel string and the bridge handles serialization.
// ─────────────────────────────────────────────────────────────────────────────

interface BroadcastEnvelope<S, M> {
  type: string; // === `channel`
  msg: M | null;
  state: S;
}

interface DispatchEnvelope<M> {
  type: string; // === `${channel}:dispatch`
  msg: M;
}

interface HydrateRequest {
  type: string; // === `${channel}:hydrate`
}

/**
 * Wire shape of one entry in the hydrate `backlog`. Mirrors a single
 * broadcast envelope, but without the `type` discriminator (the parent
 * `HydrateResponse` already identified the channel).
 */
interface BacklogEntry<V, M> {
  msg: M | null;
  state: V;
}

interface HydrateResponse<S, M> {
  state: S;
  /**
   * The runtime's history (most recent transitions, oldest first) projected
   * through `serialize` if provided. Present when the host runtime was
   * started with `historySize > 0`; an empty array otherwise. The surface
   * replays each entry through registered listeners before firing the
   * current-state marker, so a late subscriber sees the recent msg log AND
   * the current state on connect — not just the current state.
   */
  backlog: BacklogEntry<S, M>[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Background side — bridgeRuntime(runtime, { channel, serialize? })
// ─────────────────────────────────────────────────────────────────────────────

export interface BridgeRuntimeOpts<S, V = S> {
  channel: string;
  /**
   * Optional projection from the runtime's live state `S` to a JSON-safe
   * view `V` that goes over the wire (broadcast + hydrate). Required when
   * `S` carries non-serializable values (DOM refs, Map, Date, …).
   *
   * Identity passthrough by default — existing callers with POJO state pass
   * `serialize` unset and `V = S`.
   *
   * Wire shape with `serialize`:
   *   { type: channel, msg, state: serialize(currentState) }   // broadcast
   *   { type: hydrate } → { state: serialize(currentState) }    // hydrate
   *
   * Dispatch is NOT affected — it carries `M` end-to-end. Surfaces parse the
   * `V` they receive (they should pick a type parameter matching the
   * projection).
   */
  serialize?: (state: S) => V;
  /**
   * If > 0, the bridge composes a `historyTracker(runtime, size)` over the
   * runtime and returns the captured `(msg, state)` backlog in every
   * `:hydrate` reply. Late subscribers receive recent traffic on connect —
   * the inspector then sees prior tool calls / phase transitions instead
   * of just the current state snapshot.
   *
   * Defaults to 0 (no tracker, empty backlog). Composition stays opt-in:
   * the substrate is untouched, the dispatch loop is untouched, and the
   * bridge attaches the tracker only when this opt is set. Cleanup is
   * the bridge's responsibility — the disposer returned by `bridgeRuntime`
   * stops the tracker along with the observer.
   *
   * Memory cost: ~size × (msg + state) bytes, in-memory only, dies with
   * the bridge. Privacy: backlog entries flow to every `:hydrate` reply —
   * any surface that can hydrate sees them. Do not enable on bridges
   * carrying user secrets.
   */
  historySize?: number;
}

/**
 * Install the bridge for a runtime. Returns a cleanup function that removes
 * the observer and the chrome listener.
 *
 * - **Broadcast:** every (msg, state) transition emits
 *   `{ type: channel, msg, state }` via `chrome.runtime.sendMessage`. The
 *   send is fire-and-forget — when no surface is listening, chrome.runtime
 *   rejects with "Could not establish connection. Receiving end does not
 *   exist." which we swallow. If `serialize` is provided, `state` carries
 *   `serialize(state)` instead of the raw state.
 * - **Hydrate:** `{ type: ":hydrate" }` is answered via `sendResponse` with
 *   the current (optionally projected) `runtime.getState()`. If the runtime
 *   is mid-boot (store load not yet resolved), `getState()` throws — we
 *   swallow and reply with `state: null`; surfaces should treat null as
 *   "not ready yet" and wait for the first broadcast.
 * - **Dispatch:** `{ type: ":dispatch", msg }` routes to `runtime.dispatch`.
 *   Returns `true` from the listener so chrome keeps the message channel
 *   open until dispatch's promise settles (we ack with `{ ok: true }`).
 */
export function bridgeRuntime<S, M extends { type: string }, V = S>(
  runtime: Runtime<S, M>,
  { channel, serialize, historySize }: BridgeRuntimeOpts<S, V>,
): () => void {
  const dispatchType = `${channel}:dispatch`;
  const hydrateType = `${channel}:hydrate`;
  // Default to identity passthrough when no projection is provided. The
  // type parameter defaults `V = S` so callers with no projection see no
  // change in the wire-shape — the broadcast still carries `S`.
  const project: (state: S) => V =
    serialize ?? ((state: S): V => state as unknown as V);
  // Compose a history tracker only when the caller opted in. Substrate
  // (`@demlik/tea`'s `run()`) knows nothing about history — the tracker is a
  // pure composition over `runtime.observe(...)`, owned by the bridge.
  // `null` when unset means "no backlog in :hydrate replies"; the wire
  // shape stays uniform (backlog is always an array, possibly empty).
  const tracker: HistoryTracker<S, M> | null =
    historySize !== undefined && historySize > 0
      ? historyTracker(runtime, historySize)
      : null;

  // The broadcast wire still carries `msg: M | null` — surfaces depend on the
  // boot frame (`msg: null`) to hydrate from the bridge. Applied transitions now
  // arrive via `observe` with a total `msg`; the boot frame arrives via `onBoot`
  // (#47). One helper builds the envelope for both.
  const sendBroadcast = (msg: M | null, state: S): void => {
    const envelope: BroadcastEnvelope<V, M | null> = {
      type: channel,
      msg,
      state: project(state),
    };
    chrome.runtime.sendMessage(envelope).catch(() => {
      // No surface listening — drop silently. Costs are negligible at
      // typical audit-event rates; surfaces poll on hydrate on open.
    });
  };
  const unobserve = runtime.observe((msg, state) => {
    sendBroadcast(msg, state);
  });
  const unboot = runtime.onBoot((state) => {
    sendBroadcast(null, state);
  });

  const onMessage = (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean | undefined => {
    if (!message || typeof message !== "object") return undefined;
    const obj = message as Record<string, unknown>;

    if (obj.type === hydrateType) {
      let state: V | null;
      try {
        state = project(runtime.getState());
      } catch {
        // Runtime still booting (store.load pending). Surfaces fall back to
        // waiting for the first broadcast.
        state = null;
      }
      // Read the tracker's snapshot and project each entry's state through
      // `serialize`. When `historySize` was unset (tracker === null) we
      // send `[]` — uniform wire shape means surfaces never branch on
      // "did the bridge enable history" — they always iterate.
      const backlog: BacklogEntry<V, M>[] = tracker
        ? tracker
            .snapshot()
            .map((entry) => ({ msg: entry.msg, state: project(entry.state) }))
        : [];
      const response: HydrateResponse<V | null, M> = { state, backlog };
      sendResponse(response);
      return false;
    }

    if (obj.type === dispatchType) {
      const msg = obj.msg as M;
      runtime
        .dispatch(msg)
        .then(() => {
          sendResponse({ ok: true });
        })
        .catch((err: unknown) => {
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true; // keep channel open for async sendResponse
    }

    return undefined;
  };

  chrome.runtime.onMessage.addListener(onMessage);

  return () => {
    unobserve();
    unboot();
    chrome.runtime.onMessage.removeListener(onMessage);
    // Detach the history observer too — leaving it attached after the
    // bridge tears down would silently retain memory and keep observing
    // a runtime whose backlog can no longer reach any consumer.
    tracker?.stop();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Surface side — the bridge half that lives in a React surface. Exported as
// a pure helper so the React adapter (or a test) wires the listeners and the
// hydrate round-trip with the same wire format the host emits.
//
// Note: this file deliberately has NO React import. The React hook lives in
// `react.ts` and consumes these helpers. Keeps the bridge testable in plain
// vitest without happy-dom + React renderers.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The explicit opt-out of inbound msg parsing: an identity pass-through that
 * casts the raw `unknown` to `M`. Surfaces that gate only on state and treat
 * the broadcast msg as advisory pass this as `parseMsg` to acknowledge — at
 * the call site, in the types — that they are NOT parsing the msg boundary.
 *
 * This is the same behavior the old optional-`parseMsg` default had, but the
 * unsound cast now lives at one named, greppable, opt-in seam instead of being
 * the silent default for everyone. (Inv 8: the boundary parses; this helper is
 * the documented exception, chosen explicitly.)
 */
export function passThroughMsg<M>(raw: unknown): M | null {
  return raw as M;
}

export interface BridgeClient<S, M> {
  /** Send the hydrate request; resolves with the initial snapshot (or null
   * if the host is still booting OR the response failed to parse). Also
   * primes `getSnapshot()` so React's `useSyncExternalStore` sees the
   * hydrated value on the next render. */
  hydrate(): Promise<S | null>;
  /** Send a dispatch envelope; resolves once the host's dispatch settles. */
  dispatch(msg: M): Promise<void>;
  /** Subscribe to broadcasts. Returns a cleanup function. Broadcasts whose
   * payload fails `parseState` or `parseMsg` are dropped silently — the
   * listener is not called. Each successful broadcast updates
   * `getSnapshot()`. */
  subscribe(listener: (msg: M | null, state: S) => void): () => void;
  /** Synchronous accessor for the latest known state, or `null` until the
   * first successful hydrate or broadcast lands. Required reference stability
   * for `useSyncExternalStore`: returns the SAME object reference when the
   * underlying state hasn't changed since the prior call. */
  getSnapshot(): S | null;
}

export interface BridgeClientOpts<S, M> {
  channel: string;
  /**
   * REQUIRED parse for inbound `state` payloads (from `:hydrate` reply AND
   * every broadcast). Chrome runtime messages are an `unknown` boundary
   * (Inv 8) — the surface is the only party that knows the domain type `S`,
   * so it owns the boundary parse. Returning `null` drops the payload
   * silently (subscriber not called; hydrate resolves to `null`). The
   * parser MUST NOT throw — model rejection as `null`.
   */
  parseState: (raw: unknown) => S | null;
  /**
   * REQUIRED parse for inbound `msg` payloads on broadcasts. Chrome runtime
   * messages are an `unknown` boundary (Inv 8) just like the `state` payload,
   * so the msg crosses the same JSON serialization seam and must be parsed —
   * never cast. Returning `null` drops the broadcast silently.
   *
   * Surfaces that treat the msg union as advisory and only gate on state opt
   * out EXPLICITLY by passing the {@link passThroughMsg} helper — the opt-out
   * is now a visible call-site decision, not a hidden default that lets an
   * unparsed `unknown` reach listeners typed as `M`.
   */
  parseMsg: (raw: unknown) => M | null;
}

export function bridgeClient<S, M extends { type: string }>({
  channel,
  parseState,
  parseMsg,
}: BridgeClientOpts<S, M>): BridgeClient<S, M> {
  const dispatchType = `${channel}:dispatch`;
  const hydrateType = `${channel}:hydrate`;
  // Closure-held latest snapshot. `useSyncExternalStore` reads this via
  // `getSnapshot`; the reference is stable across calls until a hydrate
  // reply or broadcast overwrites it. Identity matters: returning a new
  // object for the same logical state would loop React. `null` is the
  // pre-hydrate sentinel.
  let latestState: S | null = null;
  // Each active subscribe() registers a listener. Hydrate replies notify
  // every subscriber with `msg: null` (no host transition occurred — the
  // change source is the hydrate round-trip) so `useSyncExternalStore`
  // sees the snapshot update on first mount.
  const listeners = new Set<(msg: M | null, state: S) => void>();

  const client: BridgeClient<S, M> = {
    async hydrate(): Promise<S | null> {
      const req: HydrateRequest = { type: hydrateType };
      const res = (await chrome.runtime.sendMessage(req)) as
        | { state: unknown; backlog?: unknown }
        | undefined;
      // Replay the backlog FIRST — listeners observing for a msg log see
      // historical (msg, state) pairs in oldest-first order before the
      // current-state marker. Backlog entries that fail boundary parse are
      // dropped silently (same posture as live broadcasts). When the host
      // didn't enable history, `backlog` is `[]` and this loop is a no-op.
      replayBacklog(res?.backlog, parseState, parseMsg, listeners, (next) => {
        latestState = next;
      });
      const raw = res?.state;
      if (raw === undefined || raw === null) return null;
      const parsed = parseState(raw);
      if (parsed === null) return null;
      latestState = parsed;
      // Fire the current-state marker (msg = null) — distinct from any
      // backlog entry. Surfaces that show "X just connected" key off this.
      for (const l of listeners) l(null, parsed);
      return parsed;
    },

    async dispatch(msg: M): Promise<void> {
      const env: DispatchEnvelope<M> = { type: dispatchType, msg };
      await chrome.runtime.sendMessage(env);
    },

    subscribe(listener: (msg: M | null, state: S) => void): () => void {
      listeners.add(listener);
      const onMessage = (message: unknown): void => {
        if (!message || typeof message !== "object") return;
        const obj = message as Record<string, unknown>;
        if (obj.type !== channel) return;
        // Boundary parse (Inv 8): chrome runtime messages are `unknown`.
        // A failed state parse drops the broadcast — null state would
        // be indistinguishable from "host still booting" and is not a
        // useful signal to surfaces. The msg is parsed through the
        // (required) `parseMsg`; a null result drops the broadcast too.
        const state = parseState(obj.state);
        if (state === null) return;
        let msg: M | null;
        if (obj.msg === null || obj.msg === undefined) {
          msg = null;
        } else {
          msg = parseMsg(obj.msg);
          if (msg === null) return;
        }
        latestState = state;
        listener(msg, state);
      };
      chrome.runtime.onMessage.addListener(onMessage);
      return () => {
        chrome.runtime.onMessage.removeListener(onMessage);
        listeners.delete(listener);
      };
    },

    getSnapshot(): S | null {
      return latestState;
    },
  };

  return client;
}

/**
 * Shared backlog-replay helper used by both `bridgeClient` and
 * `bridgeTabClient`. Iterates raw entries from the wire, runs each through
 * the same boundary-parse rules a live broadcast would (parseState +
 * parseMsg, both returning `null` to drop), and fires the listeners with the
 * parsed `(msg, state)` pair. Updates the closure-held `latestState` via
 * `commitState` so post-replay `getSnapshot()` returns the most recent backlog
 * state if the current-state marker is absent or unparseable.
 *
 * Extracted so the two clients can't drift in how they parse backlog
 * payloads — both must stay symmetric with their live `subscribe` parse.
 */
function replayBacklog<S, M extends { type: string }>(
  raw: unknown,
  parseState: (raw: unknown) => S | null,
  parseMsg: (raw: unknown) => M | null,
  listeners: Set<(msg: M | null, state: S) => void>,
  commitState: (next: S) => void,
): void {
  if (!Array.isArray(raw)) return;
  for (const entryRaw of raw) {
    if (!entryRaw || typeof entryRaw !== "object") continue;
    const entry = entryRaw as Record<string, unknown>;
    const state = parseState(entry.state);
    if (state === null) continue;
    let msg: M | null;
    if (entry.msg === null || entry.msg === undefined) {
      msg = null;
    } else {
      msg = parseMsg(entry.msg);
      if (msg === null) continue;
    }
    commitState(state);
    for (const l of listeners) l(msg, state);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SW-side client of a content-script-hosted runtime.
//
// `bridgeClient` above sends via `chrome.runtime.sendMessage`, which lands on
// the SW's `chrome.runtime.onMessage`. That's the surface-to-SW direction.
//
// For the SW-to-content direction we need:
//   - SENDS via `chrome.tabs.sendMessage(tabId, …)` — `chrome.runtime.sendMessage`
//     does NOT reach content scripts running in a tab.
//   - BROADCAST subscribers must filter on `sender.tab?.id === tabId`, since
//     every tab's content script broadcasts through the same SW
//     `chrome.runtime.onMessage`. Without the filter, a SW client subscribed
//     to "tab 17" would also see broadcasts from tabs 22, 31, ….
//
// Shape mirrors `BridgeClient<S, M>` so consumers can pick the constructor by
// context and use the rest of the surface identically.
// ─────────────────────────────────────────────────────────────────────────────

export interface BridgeTabClientOpts<S, M> {
  tabId: number;
  channel: string;
  /**
   * REQUIRED parse for inbound `state` payloads. See `BridgeClientOpts.parseState`
   * — same contract, same rationale. Chrome runtime messages from a tab are
   * an `unknown` boundary; the SW client owns the parse.
   */
  parseState: (raw: unknown) => S | null;
  /**
   * REQUIRED parse for inbound `msg` payloads. See `BridgeClientOpts.parseMsg`
   * — same contract, same rationale. Opt out of msg parsing with
   * {@link passThroughMsg}.
   */
  parseMsg: (raw: unknown) => M | null;
}

/**
 * SW-side client of a `bridgeRuntime` hosted in a content script.
 *
 * Identical contract to `bridgeClient` (same `BridgeClient<S, M>` shape).
 * Differences are confined to transport:
 *
 * - `hydrate()` / `dispatch(msg)` send via `chrome.tabs.sendMessage(tabId, …)`.
 *   If the tab is gone, `chrome.tabs.sendMessage` rejects (same shape as
 *   `chrome.runtime.sendMessage` with no receiver) — the promise propagates
 *   the rejection. Callers decide whether to retry, drop, or surface; the
 *   bridge has no opinion. Fire-and-forget posture matches `bridgeRuntime`.
 * - `subscribe(listener)` registers a `chrome.runtime.onMessage` listener
 *   filtered by both `envelope.type === channel` AND `sender.tab?.id === tabId`,
 *   so broadcasts from other tabs are ignored (no cross-contamination across
 *   per-tab content-script runtimes).
 */
export function bridgeTabClient<S, M extends { type: string }>({
  tabId,
  channel,
  parseState,
  parseMsg,
}: BridgeTabClientOpts<S, M>): BridgeClient<S, M> {
  const dispatchType = `${channel}:dispatch`;
  const hydrateType = `${channel}:hydrate`;
  let latestState: S | null = null;
  const listeners = new Set<(msg: M | null, state: S) => void>();

  const client: BridgeClient<S, M> = {
    async hydrate(): Promise<S | null> {
      const req: HydrateRequest = { type: hydrateType };
      const res = (await chrome.tabs.sendMessage(tabId, req)) as
        | { state: unknown; backlog?: unknown }
        | undefined;
      // Mirror bridgeClient.hydrate's backlog replay: same parse rules,
      // same oldest-first ordering, same current-state-marker semantics.
      // The two helpers diverge only in transport (tabs vs runtime), not
      // in protocol shape.
      replayBacklog(res?.backlog, parseState, parseMsg, listeners, (next) => {
        latestState = next;
      });
      const raw = res?.state;
      if (raw === undefined || raw === null) return null;
      const parsed = parseState(raw);
      if (parsed === null) return null;
      latestState = parsed;
      for (const l of listeners) l(null, parsed);
      return parsed;
    },

    async dispatch(msg: M): Promise<void> {
      const env: DispatchEnvelope<M> = { type: dispatchType, msg };
      await chrome.tabs.sendMessage(tabId, env);
    },

    subscribe(listener: (msg: M | null, state: S) => void): () => void {
      listeners.add(listener);
      const onMessage = (
        message: unknown,
        sender: chrome.runtime.MessageSender,
      ): void => {
        if (sender.tab?.id !== tabId) return;
        if (!message || typeof message !== "object") return;
        const obj = message as Record<string, unknown>;
        if (obj.type !== channel) return;
        // Boundary parse (Inv 8) — mirror bridgeClient.
        const state = parseState(obj.state);
        if (state === null) return;
        let msg: M | null;
        if (obj.msg === null || obj.msg === undefined) {
          msg = null;
        } else {
          msg = parseMsg(obj.msg);
          if (msg === null) return;
        }
        latestState = state;
        listener(msg, state);
      };
      chrome.runtime.onMessage.addListener(onMessage);
      return () => {
        chrome.runtime.onMessage.removeListener(onMessage);
        listeners.delete(listener);
      };
    },

    getSnapshot(): S | null {
      return latestState;
    },
  };

  return client;
}
