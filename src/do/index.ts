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
// The first-class durable-timer / alarm-carrier (#180). Every native-DO grain
// (raft's election/heartbeat deadline, vortex's game tick) hand-rolled the same
// compute-next-deadline → `setAlarm` → `alarm()` → fire → re-arm loop after the
// `do_alarm` Sub was dropped (see the historical note above). `durableTimer`
// owns that loop in ONE tested place: idle-when-no-work (`nextDeadline` → null),
// eviction-safe across hibernation (the deadline is a pure function of persisted
// state, re-armed on cold wake), alarm injected as the same minimal
// `AlarmStorage` port `stepHost` takes. See `./durable-timer`.
export {
  type DurableTimer,
  type DurableTimerConfig,
  durableTimer,
} from "./durable-timer";
// Opt-in event-sourcing persistence mode. `doStore` below stays the DEFAULT
// (snapshot-only, byte-for-byte unchanged); `doEventSourcedStore` is the
// explicit alternative that appends each Msg to a log, snapshots periodically,
// and rebuilds state by folding the log on the latest snapshot at activation.
export {
  doEventSourcedStore,
  type EventLogRange,
  type EventSourcedOptions,
  type EventSourcedStore,
  type PersistedEvent,
} from "./event-sourced-store";
// The minimum-viable DO HOST for a `createAgent` runtime — the deferred-tool
// gateway, auto-boot, WS accept + inbound bridge, runtime→SSE plumbing, the
// terminal-output capture. Kept in a sibling file so this
// module stays the durability + subs surface; the host re-exports through the
// same `@demlik/tea/do` subpath the consumer already imports `doStore` from.
export {
  type AgentHost,
  type AgentHostConfig,
  acceptCommandSocket,
  acceptDurableCommandSocket,
  agentIsResumable,
  autoBoot,
  bootResume,
  broadcast,
  broadcastHibernatable,
  createAgentHost,
  type DeferredGateway,
  type DurableCommandCarrier,
  deferredGateway,
  durableCommandCarrier,
  durableDeferredGateway,
  type HibernatableCtx,
  type ResumePort,
  reissueSurvivingEffects,
  type SseHub,
  sseFromAgentEvents,
  sseHub,
  sseProjection,
} from "./host";
// The receiver/effect-side dedup half of durable effects (#227). The ledger
// above is at-least-once (surviving owed effects re-fire on activation); this
// brick swallows the duplicate at the external write, keyed by a caller-supplied
// durable `EffectKey` folded into the Store alongside State (an `effect_applied`
// marker, pruned by `effect_forgotten` — the ledger's confirm-removes-entry
// retention). Together: effectively-once. See `./idempotent-effect`.
export {
  type AppliedEffects,
  type AppliedEffectsEvent,
  type AppliedEffectsGuard,
  appliedEffects,
  applyAppliedEvent,
  type EffectApplied,
  type EffectForgotten,
  type EffectKey,
  emptyApplied,
  foldApplied,
  type IdempotentEffect,
  type IdempotentOutcome,
  idempotentEffect,
  isApplied,
} from "./idempotent-effect";
// Generic hibernatable PRESENCE + BROADCAST for a NATIVE (non-agent) DO grain
// (#181). The `./host` broadcast/accept helpers above are framed for the
// LLM-agent deferred-tool gateway (`createAgentHost`); these are the decoupled,
// transport/Msg-agnostic equivalents a game / presence / collab grain uses —
// `broadcastFrame` takes the socket SET as input (DI-friendly, pure, testable
// with fakes), and `acceptPresenceSocket` / `registerHibernatableSocket` lift
// the `WebSocketPair` + `ctx.acceptWebSocket` + `serializeAttachment` boilerplate.
export {
  type AttachableSocket,
  acceptPresenceSocket,
  type BroadcastOptions,
  type BroadcastReport,
  broadcastFrame,
  type PresenceCtx,
  type PresenceSocket,
  type PresenceUpgrade,
  presenceCount,
  type RegisterOptions,
  registerHibernatableSocket,
  WS_READY_STATE_OPEN,
} from "./presence";
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
// The HTTP-PULL control carrier (#92) — a hibernation-correct SIBLING to
// `acceptCommandSocket`. The hands drive a `/step` loop (execute a tool, POST
// the result, get the next tool); each POST wakes the DO, settles the result
// idempotently, resumes from the durable checkpoint, returns the next step, and
// lets the DO hibernate. Carrier-selection rule lives in the `step-host.ts`
// header: PULL for the cold-between-steps control plane, PUSH (WS/SSE above)
// for unsolicited view/fan-out. Both commonly run in one DO.
export {
  type AlarmStorage,
  constantTimeEqual,
  type DeferResumeHook,
  type DeferredStepOutcome,
  type DeferredStepResponse,
  type DeferStepHostConfig,
  type ExecuteStep,
  mintRunToken,
  type NextStep,
  type RunStepLoopConfig,
  runStepLoop,
  type StepCtx,
  type StepEngine,
  type StepHostConfig,
  type StepLoopOutcome,
  type StepOutcome,
  type StepRequest,
  type StepResponse,
  type StepResult,
  type StepTransport,
  type StepWorking,
  stepHost,
} from "./step-host";

// ─────────────────────────────────────────────────────────────────────────────
// doStore — `Store<S>` over DurableObjectStorage.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STATE_KEY = "@@state";

/**
 * Options for {@link doStore}. Mirrors the optional-bag shape
 * `doEventSourcedStore` already uses for its `parse`/`keys`, so the two DO
 * stores read alike.
 */
export interface DoStoreOptions<S> {
  /** Storage key the snapshot cell lives at. Defaults to `@@state`. */
  readonly key?: string;
  /**
   * The serialize half of the boundary (#182) — the INVERSE of `doStore`'s
   * `parse`. Maps the live `S` to a JSON-safe carrier before `JSON.stringify`,
   * so a Model holding a `Map`/`Set`/`Date` (which `JSON.stringify` would
   * silently flatten) round-trips: `parse` reconstructs the rich `S` from the
   * carrier on load. Omit for a plain-JSON Model (the identity default — the
   * `Record`-not-`Map` constraint, unchanged). When present, `parse` MUST
   * accept whatever `serialize` produces.
   */
  readonly serialize?: (state: S) => unknown;
}

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
 *
 * Serialization sharp edge (#182): `save` JSON-serializes the Model, and
 * `JSON.stringify` does NOT survive a `Map`/`Set`/`Date` (a `Map` stringifies
 * to `{}`, silently losing every entry). A Model that wants a `Map` (the
 * natural "roster keyed by id") therefore supplies a `serialize` hook — the
 * INVERSE of `parse` — so the boundary owns both directions: `serialize` turns
 * the live `S` into a JSON-safe carrier on the way out, `parse` reconstructs
 * the rich `S` from that carrier on the way back in. They are a matched pair:
 * `parse(JSON.parse(JSON.stringify(serialize(state))))` must round-trip to a
 * value equal to `state`. Omit `serialize` and the Model must stay plain-JSON
 * (the `Record`-not-`Map` constraint the default imposes, unchanged).
 *
 * @param parse - boundary parse, the deserialize half (`unknown -> S | null`).
 * @param keyOrOptions - either the storage key (legacy positional form,
 *   defaults to `@@state`) or a {@link DoStoreOptions} bag carrying `key`
 *   and/or the `serialize` hook. A bare string is treated as `{ key }`.
 */
export function doStore<S>(
  storage: DurableObjectStorage,
  parse: (raw: unknown) => S | null,
  keyOrOptions: string | DoStoreOptions<S> = DEFAULT_STATE_KEY,
): Store<S> {
  // Normalize the legacy positional `key` string and the options bag to one
  // shape, so the body reads a single `key` + `serialize` regardless of which
  // call form the caller used. Backward-compatible: a string `keyOrOptions`
  // is exactly the old behavior with the identity serializer.
  const options: DoStoreOptions<S> =
    typeof keyOrOptions === "string" ? { key: keyOrOptions } : keyOrOptions;
  const key = options.key ?? DEFAULT_STATE_KEY;
  // Identity by default: the Model is serialized as-is (the plain-JSON path).
  const serialize: (state: S) => unknown =
    options.serialize ?? ((state: S): unknown => state);
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
      // `serialize` is the inverse of `parse` — it maps the live `S` (which may
      // hold a Map/Set) to a JSON-safe carrier before `JSON.stringify` (#182).
      await storage.put(key, JSON.stringify(serialize(state)));
    },
    migrate(raw: unknown): S | null {
      return parse(raw);
    },
  };
}
