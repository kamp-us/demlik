/// <reference types="@cloudflare/workers-types" />
/**
 * @demlik/tea/do — Durable Object adapter for `@demlik/tea`.
 *
 * The integration is built on ONE transport model and one durability primitive:
 *
 *   1. `doStore<S>(storage, parse, key?)` — `Store<S>` impl backed by
 *      `DurableObjectStorage`. JSON-stringifies on save, JSON-parses on load
 *      and returns `unknown` (invariant-8 boundary); the substrate then calls
 *      `migrate(raw)` (which forwards to `parse`) to turn it into `S | null`.
 *      Returns `null` (typed as `unknown`) when the key is absent. Structural
 *      JSON malformation throws at load — `run()`'s boot path surfaces that
 *      (PRD throw-semantics table: "store.load throw at boot → run() throws
 *      synchronously"). Shape mismatch is NOT a throw — `parse` returns
 *      `null` and the substrate boots fresh.
 *
 *   2. `deferredGateway` + `createAgentHost` (from `./host`) — THE transport for
 *      a DO-hosted agent. A `createAgent().toMachine()` machine owns exactly one
 *      Sub type, `DeadlineSub` (the agent's own retry + watchdog timers); it has
 *      no DO-native Sub variant to compose, and it needs none. The gateway owns
 *      each deferred tool round-trip as a Promise the interpret cell awaits:
 *        - Inbound WebSocket frames are bridged straight into `gateway.settle(...)`
 *          from the DO's `webSocketMessage` lifecycle method — a direct dispatch,
 *          NOT a Sub.
 *        - The per-tool deadline is a `setTimeout` inside the gateway, NOT a DO
 *          alarm.
 *      One model: the transport lives outside the Sub system, bridged into
 *      `dispatch` by the gateway. See `./host`'s module doc for the full rationale
 *      and `.patterns/tea/durable-actors.md` for the host-layer north star.
 *
 * (Historical note: this module previously also shipped `do_ws` / `do_alarm`
 * Subs + a `doSubscribe` registry. Because `toMachine` fixes the agent machine's
 * Sub type to `DeadlineSub`, those Subs could never union into an agent host's
 * Sub set — they were structurally unusable by the flagship consumer and had no
 * callers. They were dropped in favor of the gateway as the single transport.)
 */

import type { Store } from "../index";

// Durable pending-effects ledger (ADR 0003 primitive #1 — durable effects).
// A pure fold over `effect_owed` / `effect_confirmed` events (NOT a side
// table): owed adds, confirmed removes, and the surviving entries re-emit on
// activation, idempotent by monotonic delivery id. Persist the two events into
// the same log `doEventSourcedStore` appends and the ledger rebuilds for free.
export {
  applyEffectEvent,
  type DeliveryId,
  type EffectConfirmed,
  type EffectLedgerEvent,
  type EffectOwed,
  emptyLedger,
  foldLedger,
  isOwed,
  type OwedEffect,
  type PendingEffectsLedger,
  type PendingEffectsRecorder,
  pendingEffectsLedger,
  survivingEffects,
} from "./durable-effects";
// Opt-in event-sourcing persistence mode. `doStore` below stays the DEFAULT
// (snapshot-only, byte-for-byte unchanged); `doEventSourcedStore` is the
// explicit alternative that appends each Msg to a log, snapshots periodically,
// and rebuilds state by folding the log on the latest snapshot at activation.
export {
  doEventSourcedStore,
  type EventSourcedOptions,
  type EventSourcedStore,
} from "./event-sourced-store";

// The minimum-viable DO HOST for a `createAgent` runtime — the deferred-tool
// gateway, auto-boot, WS accept + inbound bridge, runtime→SSE plumbing, the
// terminal-output capture, and `dispatchToIdle`. Kept in a sibling file so this
// module stays the durability + subs surface; the host re-exports through the
// same `@demlik/tea/do` subpath the consumer already imports `doStore` from.
export {
  type AgentHost,
  type AgentHostConfig,
  acceptCommandSocket,
  acceptDurableCommandSocket,
  agentIsResumable,
  autoBoot,
  broadcast,
  broadcastHibernatable,
  createAgentHost,
  type DeferredGateway,
  type DurableCommandCarrier,
  deferredGateway,
  dispatchToIdle,
  durableCommandCarrier,
  durableDeferredGateway,
  type HibernatableCtx,
  reissueSurvivingEffects,
  type SseHub,
  sseFromAgentEvents,
  sseHub,
  sseProjection,
} from "./host";

// CQRS projections as a first-class seam (#69). One write model, many
// projections: each is an independent `(events|Model) → view` fold into its own
// id-scoped read model with an EXCLUSIVE offset (resume + idempotent apply are
// one unit). `sseHub` (re-exported above) is now expressible as ONE projection
// via `sseProjection`. See `.patterns/tea-do/projections.md`,
// `offset-tracking.md`, `delivery-semantics.md`.
export {
  driveProjections,
  type Projection,
  type ProjectionId,
  type ProjectionRegistry,
  type ProjectionRunner,
  type ProjectionUpdate,
  projectionIdString,
  projectionRegistry,
  rebuildProjection,
  runProjection,
} from "./projection";

// ─────────────────────────────────────────────────────────────────────────────
// doStore — `Store<S>` over DurableObjectStorage.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STATE_KEY = "@@state";

/**
 * `Store<S>` over `DurableObjectStorage`.
 *
 * `parse` is REQUIRED because DO storage is a real serialization boundary —
 * the bytes that come back through `JSON.parse` are structurally `unknown`,
 * and the caller (the DO that owns `S`) is the only party with enough
 * information to validate the shape. Returning `null` from `parse` means
 * "no usable persisted state" — the substrate boots `init` with `loaded =
 * null`, a known-good fresh-boot path. `parse` must NOT throw per the
 * `Store<S>.migrate` contract; shape mismatch is a value (null), not a
 * panic.
 *
 * Structural malformations (the stored cell isn't even JSON) still throw at
 * `load()` — that's an infrastructure error, distinct from a schema
 * mismatch. The substrate surfaces it via `runtime.ready` rejection.
 *
 * Concrete bite this closes: when a `State` variant is renamed between
 * deploys, the DO's new code previously received a value typed as the new
 * `S` that held a runtime string from the old `S` — silent undefined
 * behavior in `init`/`update`. After this, the boundary parse rejects the
 * old shape (returns null) and the DO boots fresh, picking up its new
 * schema from the next dispatch onward.
 */
export function doStore<S>(
  storage: DurableObjectStorage,
  parse: (raw: unknown) => S | null,
  key: string = DEFAULT_STATE_KEY,
): Store<S> {
  return {
    async load(): Promise<unknown> {
      const raw = await storage.get<string>(key);
      if (raw === undefined || raw === null) return null;
      // JSON.parse throws on malformed — propagate per PRD throw-semantics.
      // The decoded value is intentionally returned as `unknown`; the
      // substrate's `migrate` callback (forwarded from `parse`) is the
      // boundary parse that turns it into `S | null`.
      return JSON.parse(raw);
    },
    async save(state: S): Promise<void> {
      await storage.put(key, JSON.stringify(state));
    },
    migrate(raw: unknown): S | null {
      return parse(raw);
    },
  };
}
