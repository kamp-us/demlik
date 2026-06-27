/// <reference types="@cloudflare/workers-types" />
/**
 * @demlik/tea/do — CQRS projections as a first-class seam.
 *
 * TODAY (`./host`), "Model → views" is ad-hoc: `sseHub` is a hand-rolled
 * sink-set fanning `runtime.observe` events out. It re-derives a common shape:
 * subscribe to `observe`, fold each update into a private view, push the view
 * at a sink. (The run's terminal output was once another such observe-driven
 * read model — `captureLastTurn` — but that is now modelled first-class on the
 * write model itself as `state.output` / `runtime.result()`, #46.)
 *
 * This file names that shape. A `Projection<Model, View>` is the canon's
 * "one write model, many projections" contract made concrete on the tea
 * substrate (`.patterns/tea-do/projections.md`):
 *
 *   1. ONE WRITE MODEL, MANY PROJECTIONS. The write model is the agent's `run()`
 *      State (`Model`) plus its `Msg` stream. Each projection is an INDEPENDENT
 *      `(events|Model) → view` derivation into its OWN read model, with its own
 *      id-scoped offset. Adding a projection never touches the write model or
 *      any other projection — it only registers another consumer of `observe`.
 *
 *   2. OFFSET-RESUME + IDEMPOTENT APPLY ARE ONE UNIT. A durable projection
 *      tracks an EXCLUSIVE offset — the last applied position. On restart it
 *      resumes STRICTLY AFTER the stored offset (never ±1); at-least-once
 *      delivery means the same update may be re-presented, so `apply` must be
 *      idempotent (an upsert of the derived view, never a blind increment).
 *      WHEN the offset is committed relative to the view write IS the delivery
 *      semantic (`.patterns/tea-do/delivery-semantics.md`):
 *        - commit AFTER the view write  → at-least-once  (may reprocess)
 *        - commit in the SAME step      → exactly-once   (the default here)
 *      We persist offset-with-view as one unit (a single `OffsetView` cell), so
 *      a durable projection is exactly-once by construction; the at-least-once
 *      replay window is still exercised because `drive()` may re-present an
 *      update at/below the stored offset (boot reconcile, double-observe), and
 *      the exclusive-offset guard makes that a no-op.
 *
 *   3. A VIEW IS ALWAYS REBUILDABLE. Clearing the view and resetting the offset
 *      to the start (`rebuild`) replays the `Msg`/`Model` stream from zero. The
 *      live view and the rebuilt view are equal by construction — both are the
 *      same pure `apply` fold over the same ordered updates.
 *
 * Relationship to `./host`: `sseHub` is re-expressed here as ONE projection
 * (`sseProjection`) WITHOUT changing its public API — `host.sseHub()` keeps
 * working for existing callers (it is the volatile, offset-free case: a live
 * SSE stream has no durable read model to resume).
 *
 * Relationship to `./event-sourced-store`: a durable projection resumes over
 * the SAME append-only event log `doEventSourcedStore` (#68) writes. The fold
 * is the projection's `apply`, scoped to the projection's offset — independent
 * of the write model's snapshot/replay. This file does NOT import the store; it
 * is offset-shaped so a consumer can wire either the live `observe` stream or a
 * replay over the log into the same `apply`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// ProjectionId — name + key identifies a running instance.
//
// `name` is the view ("sse", "report", "last-turn"); `key` distinguishes
// instances (shards, partitions). The stored offset is scoped to the id, so the
// key is also what lets two instances of one view track offsets independently
// (projections.md "ProjectionId"). Two projections sharing an id share an offset
// row and would fight over it — so an id is the unit of offset isolation.
// ─────────────────────────────────────────────────────────────────────────────

/** A projection's identity: `name` (the view) + `key` (the instance). */
export interface ProjectionId {
  readonly name: string;
  readonly key: string;
}

/** Render a `ProjectionId` to its canonical `name-key` string. */
export function projectionIdString(id: ProjectionId): string {
  return `${id.name}-${id.key}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Update — the envelope a projection folds.
//
// What flows past `runtime.observe(observer)` is `(msg, state)` — the applied
// `Msg` (the event) and the post-transition `Model` (the write-model state). A
// projection can fold either: an event-shaped projection reads `msg`, a
// state-shaped one reads `model`. `offset` is the exclusive position of THIS
// update in the ordered stream (monotonic, 1-based; 0 means "before the first
// update", i.e. the NoOffset start). The boot observe (`msg === null`) carries
// the initial state and is offset 0 — a projection that only folds events skips
// it; one that derives from state may seed its view from it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One unit the projection driver presents to a projection's `apply`. Mirrors
 * the `(msg, model)` pair `runtime.observe` fans out, plus the exclusive
 * `offset` the driver assigns. `msg === null` is the boot update (no event).
 */
export interface ProjectionUpdate<Model, Msg> {
  /** The applied event, or `null` on the boot update (initial state). */
  readonly msg: Msg | null;
  /** The post-transition write-model state. */
  readonly model: Model;
  /**
   * The exclusive position of this update in the ordered stream — monotonic,
   * 1-based; 0 is the boot update (the `NoOffset` start). The stored offset is
   * EXCLUSIVE: re-presenting an update whose offset is `<=` the stored offset
   * must be a no-op (the at-least-once replay window). Do NOT ±1 it.
   */
  readonly offset: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Projection — the named fold + its sink.
//
// `apply(view, update)` is the per-envelope reducer (projections.md "Handler"):
// it derives the next `View` from the previous `View` and one update. It MUST be
// pure and idempotent w.r.t. the update's offset — re-applying the same offset
// yields the same view (upsert, not blind increment). `emit(view)` is the sink:
// SSE frame, durable cell, report row. `initial` seeds the view for a fresh /
// rebuilt run (the `NoOffset` start state).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A named CQRS projection: an independent fold of the write model's
 * `(Msg|Model)` stream into a private `View`, plus a sink to publish it.
 *
 * @typeParam Model The write-model state (`run()`'s `S`).
 * @typeParam Msg   The write-model event (`run()`'s `M`).
 * @typeParam View  The read model this projection derives.
 */
export interface Projection<Model, Msg extends { type: string }, View> {
  /** This projection's id (offset-isolation unit). */
  readonly id: ProjectionId;
  /** The seed view for a fresh or rebuilt run (the `NoOffset` start). */
  readonly initial: View;
  /**
   * The per-envelope reducer: derive the next view from the previous view and
   * one update. Pure; MUST be idempotent — re-applying an update at the same
   * offset yields the same view (upsert the derived value, never a blind
   * increment). Returning the SAME view reference (or an equal one) for an
   * update the view does not care about is the canonical "skip".
   */
  apply(view: View, update: ProjectionUpdate<Model, Msg>): View;
  /**
   * The sink — publish the derived view. SSE frame, durable cell, report row.
   * Fired by the driver after `apply` produces a new view. A throwing `emit` is
   * isolated by the driver (it must not strand sibling projections).
   */
  emit(view: View): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectionRunner — a single projection's live read model + offset.
//
// Wraps one `Projection` with its current `view` and its EXCLUSIVE stored
// `offset`. `present(update)` is the at-least-once entry point: it folds the
// update IFF the update is strictly after the stored offset (the exclusivity
// guard), commits the offset WITH the view as one unit (exactly-once by
// construction), then emits. `reset()` clears the view to `initial` and the
// offset to 0 — the canonical view-rebuild operation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A live, running projection instance: the projection's current `View`, its
 * exclusive stored `offset`, and the `present`/`reset` operations the driver
 * (or a rebuild) calls.
 */
export interface ProjectionRunner<Model, Msg extends { type: string }, View> {
  readonly id: ProjectionId;
  /** The current derived view (the read model). */
  view(): View;
  /**
   * The exclusive stored offset — the position of the LAST applied update.
   * Resume reads strictly after this; `0` is the `NoOffset` start.
   */
  offset(): number;
  /**
   * Present one update to the projection. At-least-once entry point:
   *   - if `update.offset <= storedOffset` the update was already applied →
   *     NO-OP (idempotent replay window; offset stays, view stays, no emit).
   *   - otherwise fold via `apply`, advance the offset TO `update.offset`, and
   *     `emit` the new view. Offset-and-view advance together (one unit) →
   *     exactly-once: the stored offset always matches the folded view.
   * Returns true iff the update was applied (false on the no-op replay).
   */
  present(update: ProjectionUpdate<Model, Msg>): boolean;
  /**
   * Clear the view to `initial` and the offset to 0 — the canonical rebuild
   * reset (offset-tracking.md: "resetting it to NoOffset is the view-rebuild
   * operation"). After `reset`, re-presenting the full stream rebuilds the view.
   */
  reset(): void;
}

/**
 * Build a {@link ProjectionRunner} for a projection, starting from a stored
 * offset (default 0 = `NoOffset`, a fresh run). The view is seeded to
 * `projection.initial`; the caller resumes by presenting updates strictly after
 * `startOffset` (the driver's offset guard enforces exclusivity even if an
 * already-applied update is re-presented).
 *
 * `emitOnStart`/`emitOnReset` default false: a fresh runner holds `initial` but
 * does not push it at the sink until the first real update lands (an SSE client
 * that just connected wants the next event, not a replay of the seed).
 */
export function runProjection<Model, Msg extends { type: string }, View>(
  projection: Projection<Model, Msg, View>,
  startOffset = 0,
): ProjectionRunner<Model, Msg, View> {
  let view = projection.initial;
  let storedOffset = startOffset;

  return {
    id: projection.id,
    view: () => view,
    offset: () => storedOffset,
    present(update) {
      // EXCLUSIVE-OFFSET GUARD. The stored offset is the last applied position;
      // an update at or below it was already folded into `view`. Re-presenting
      // it (boot reconcile, double-observe, log replay overlap) is the
      // at-least-once replay window — fold it again and a non-idempotent view
      // double-counts. We make the guard structural: skip it entirely. This is
      // what "exclusive offset, do NOT ±1" means in code — the stored value is
      // re-usable as-is as the resume point; the next applied update is the
      // first one strictly greater than it.
      if (update.offset <= storedOffset) return false;
      const next = projection.apply(view, update);
      // Offset advances WITH the view, as one unit — exactly-once. The stored
      // offset is never ahead of (nor behind) the view it describes.
      view = next;
      storedOffset = update.offset;
      projection.emit(next);
      return true;
    },
    reset() {
      view = projection.initial;
      storedOffset = 0;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectionRegistry — the driver. Fans `runtime.observe` to N projections.
//
// One write model, many projections: the registry holds a set of independent
// runners and `dispatch(update)` presents the SAME update to each. Each runner
// applies its own `apply` into its own view at its own offset — a failure or
// reset in one never touches another (the driver isolates `apply`/`emit`
// throws). `from(runtime)` wires the registry to `runtime.observe`, assigning a
// monotonic exclusive offset per observed transition (the boot observe is
// offset 0; the first real Msg is offset 1).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A driver over a set of projections sharing one write-model stream. Holds the
 * monotonic offset counter; presents each observed update to every registered
 * runner independently.
 */
export interface ProjectionRegistry<Model, Msg extends { type: string }> {
  /** Register a projection; returns its live runner. */
  register<View>(
    projection: Projection<Model, Msg, View>,
    startOffset?: number,
  ): ProjectionRunner<Model, Msg, View>;
  /**
   * Present one update to EVERY registered runner. Each folds independently; an
   * `apply`/`emit` throw in one runner is caught so it cannot strand the others
   * (errors-are-data: a broken projection is dropped from THIS update, not
   * allowed to corrupt siblings). Returns the offset assigned to this update.
   */
  dispatch(msg: Msg | null, model: Model): number;
  /** The current monotonic offset (the last dispatched update's position). */
  offset(): number;
  /** The registered runners (introspection / tests). */
  runners(): readonly ProjectionRunner<Model, Msg, unknown>[];
}

/** Build an empty {@link ProjectionRegistry}. */
export function projectionRegistry<
  Model,
  Msg extends { type: string },
>(): ProjectionRegistry<Model, Msg> {
  const runners = new Set<ProjectionRunner<Model, Msg, unknown>>();
  // The boot observe is offset 0; the first applied Msg is offset 1. We start at
  // -1 and pre-increment so `dispatch(null, initialState)` (the boot fanout)
  // lands on 0 and the first real Msg on 1.
  let counter = -1;

  return {
    register(projection, startOffset) {
      const runner = runProjection(projection, startOffset);
      runners.add(runner as ProjectionRunner<Model, Msg, unknown>);
      return runner;
    },
    dispatch(msg, model) {
      const offset = ++counter;
      const update = { msg, model, offset };
      for (const runner of runners) {
        try {
          runner.present(update);
        } catch {
          // A projection's apply/emit threw. Isolate it — the sibling runners
          // still see this update. The broken runner keeps its prior view +
          // offset (it did not advance), so it self-heals on a later update or
          // a rebuild. (errors-are-data: surface via the sink, never strand.)
        }
      }
      return offset;
    },
    offset: () => counter,
    runners: () => [...runners],
  };
}

/**
 * Wire a {@link ProjectionRegistry} to a runtime's transition stream. The boot
 * update (the initial state, offset 0) is presented via `onBoot`; every applied
 * transition (offset 1, 2, …) via `observe` — together they reproduce the
 * "every transition including boot" stream the single `observe(msg | null)`
 * channel used to carry, now that `observe`'s `msg` is total (#47). The registry
 * still assigns its monotonic exclusive offset (boot → 0, first Msg → 1).
 * Returns a cleanup that detaches both subscriptions.
 *
 * Typed structurally against `{ observe, onBoot }` so it accepts any
 * `Runtime<Model, Msg>` without importing the substrate's `Runtime` (types-only
 * boundary).
 */
export function driveProjections<Model, Msg extends { type: string }>(
  registry: ProjectionRegistry<Model, Msg>,
  runtime: {
    observe(observer: (msg: Msg, model: Model) => void): () => void;
    onBoot(handler: (model: Model) => void): () => void;
  },
): () => void {
  // Boot first → the registry's pre-incremented counter lands it on offset 0,
  // exactly as the old `dispatch(null, model)` boot observe did.
  const unboot = runtime.onBoot((model) => {
    registry.dispatch(null, model);
  });
  const unobserve = runtime.observe((msg, model) => {
    registry.dispatch(msg, model);
  });
  return () => {
    unobserve();
    unboot();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// rebuildProjection — replay a Msg/Model stream into a fresh runner.
//
// The rebuild operation (projections.md "a view is rebuildable"): start a fresh
// runner (offset 0, view = initial) and present the ordered stream from the
// start. The result equals the live view by construction — both are the same
// pure `apply` fold over the same ordered updates. The exclusive-offset guard
// makes the replay safe even if the stream overlaps an already-applied prefix.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild a projection's view by folding an ordered event stream from the
 * `NoOffset` start. The runner is seeded to `projection.initial` (the implicit
 * boot / `NoOffset` state), then each `updates[i]` is presented at offset
 * `i + 1` — so the FIRST event (`updates[0]`) lands at offset 1 and is folded,
 * exactly mirroring the live driver, which assigns the first applied `Msg`
 * offset 1 (the boot observe is offset 0 and never enters this list). Returns
 * the rebuilt runner whose `view()` equals the live runner's view for the same
 * ordered stream.
 *
 * Pass the ordered events only; do NOT prepend a boot (`msg === null`) entry.
 * With the `i + 1` offsets a leading boot entry would be applied at offset 1
 * like any event (the seed already covers the `NoOffset` start), not skipped —
 * the offset-0 skip that drops the boot is the live driver's, not this fold's.
 *
 * This is the rebuild-equivalence oracle: a view cleared and replayed from the
 * stream equals the live view.
 */
export function rebuildProjection<Model, Msg extends { type: string }, View>(
  projection: Projection<Model, Msg, View>,
  updates: readonly { readonly msg: Msg | null; readonly model: Model }[],
): ProjectionRunner<Model, Msg, View> {
  const runner = runProjection(projection, 0);
  updates.forEach((u, i) => {
    // Present at offset `i + 1`, NOT `i`: the runner's stored offset starts at 0
    // (the `NoOffset` seed) and `present` skips any update with `offset <= 0`, so
    // an offset-`i` first event (offset 0) would be silently dropped. Offsetting
    // by one starts the stream at offset 1 — the live driver's first-Msg offset —
    // so `updates[0]` is folded and the rebuild mirrors the live view.
    runner.present({ msg: u.msg, model: u.model, offset: i + 1 });
  });
  return runner;
}
