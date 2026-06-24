import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Cmd, defineMachine, type Reducer, run } from "../index";
import { bindMachine } from "../testing";
import {
  createSnapshot,
  type SnapshotLoadCmd,
  type SnapshotLoadedMsg,
  type SnapshotLoadFailedMsg,
  type SnapshotSavedMsg,
  type SnapshotState,
  type SnapshotStore,
  type SnapshotWriteCmd,
  snapshotFailed,
  snapshotLoaded,
  snapshotLoadFailed,
  snapshotSaved,
} from "./index";

// A snapshot value is whatever the consumer checkpoints — here a tiny run-state
// stand-in so the payload threading is observable in the emitted Cmd.
type RunState = { readonly step: number };

// The freshly-initialized slice, named once so the "no churn" assertions read
// against a single source of truth.
const FRESH: SnapshotState = {
  sinceLast: 0,
  seq: 0,
  lastSavedSeq: null,
  lastSavedAt: null,
};

describe("createSnapshot — init", () => {
  it("starts at zero progress with nothing emitted or confirmed", () => {
    const snap = createSnapshot<RunState>({ every: 5 });
    expect(snap.init()).toEqual(FRESH);
  });
});

describe("record — cadence", () => {
  it("accumulates below the cadence and emits no Cmd", () => {
    const snap = createSnapshot<RunState>({ every: 3 });
    const [s1, c1] = snap.record(FRESH, { step: 1 }, 1000);
    expect(s1).toEqual({ ...FRESH, sinceLast: 1 });
    expect(c1).toEqual([]);

    const [s2, c2] = snap.record(s1, { step: 2 }, 1001);
    expect(s2.sinceLast).toBe(2);
    expect(c2).toEqual([]);
  });

  it("checkpoints exactly when the accumulated count reaches `every`", () => {
    const snap = createSnapshot<RunState>({ every: 3, key: "run/cp" });
    let s = FRESH;
    s = snap.record(s, { step: 1 }, 10)[0];
    s = snap.record(s, { step: 2 }, 11)[0];
    const [hit, cmds] = snap.record(s, { step: 3 }, 12);

    // Counter resets the moment the write is DECIDED; seq bumps to 1.
    expect(hit).toEqual({
      sinceLast: 0,
      seq: 1,
      lastSavedSeq: null,
      lastSavedAt: null,
    });
    expect(cmds).toEqual([
      {
        type: "snapshot_write",
        key: "run/cp",
        seq: 1,
        at: 12,
        payload: { step: 3 },
      },
    ]);
  });

  it("a misconfigured every <= 0 clamps to 1 (checkpoints on every progress unit)", () => {
    const snap = createSnapshot<RunState>({ every: 0 });
    const [, cmds] = snap.record(FRESH, { step: 1 }, 5);
    expect(cmds).toHaveLength(1);
    expect((cmds[0] as SnapshotWriteCmd<RunState>).seq).toBe(1);
  });

  it("defaults the store key to @@snapshot when omitted", () => {
    const snap = createSnapshot<RunState>({ every: 1 });
    const [, cmds] = snap.record(FRESH, { step: 1 }, 5);
    expect((cmds[0] as SnapshotWriteCmd<RunState>).key).toBe("@@snapshot");
  });

  it("does not mutate the input slice", () => {
    const snap = createSnapshot<RunState>({ every: 2 });
    const before = Object.freeze({ ...FRESH });
    const [after] = snap.record(before, { step: 1 }, 5);
    expect(after).not.toBe(before);
    expect(before.sinceLast).toBe(0);
  });
});

describe("force — cadence-independent checkpoint", () => {
  it("always emits a write and bumps seq regardless of sinceLast", () => {
    const snap = createSnapshot<RunState>({ every: 100 });
    // Only one progress unit accumulated — far below the cadence.
    const [acc] = snap.record(FRESH, { step: 1 }, 10);
    expect(acc.sinceLast).toBe(1);

    const [forced, cmds] = snap.force(acc, { step: 1 }, 11);
    expect(forced).toEqual({
      sinceLast: 0,
      seq: 1,
      lastSavedSeq: null,
      lastSavedAt: null,
    });
    expect(cmds).toEqual([
      {
        type: "snapshot_write",
        key: "@@snapshot",
        seq: 1,
        at: 11,
        payload: { step: 1 },
      },
    ]);
  });
});

describe("confirm — durable watermark", () => {
  it("advances lastSavedSeq / lastSavedAt to the acknowledged write", () => {
    const snap = createSnapshot<RunState>({ every: 1 });
    const [emitted] = snap.record(FRESH, { step: 1 }, 50); // seq -> 1
    const [confirmed, cmds] = snap.confirm(emitted, snapshotSaved(1, 60));
    // An ack emits nothing — uniform reducer-cell shape with `Cmd.none`.
    expect(cmds).toEqual([]);
    expect(confirmed.lastSavedSeq).toBe(1);
    expect(confirmed.lastSavedAt).toBe(60);
    // The cadence counter is untouched by an acknowledgement.
    expect(confirmed.sinceLast).toBe(emitted.sinceLast);
  });

  it("ignores a stale ack of an older seq (watermark is forward-only)", () => {
    const snap = createSnapshot<RunState>({ every: 1 });
    const before: SnapshotState = {
      sinceLast: 0,
      seq: 2,
      lastSavedSeq: 2,
      lastSavedAt: 200,
    };
    // A slow write for seq 1 lands after seq 2 already confirmed — must not regress.
    const [after, cmds] = snap.confirm(before, snapshotSaved(1, 99));
    expect(cmds).toEqual([]);
    expect(after).toEqual({
      sinceLast: 0,
      seq: 2,
      lastSavedSeq: 2,
      lastSavedAt: 200,
    });
  });

  it("re-confirming the same seq is a no-op (idempotent ack)", () => {
    const snap = createSnapshot<RunState>({ every: 1 });
    const s: SnapshotState = {
      sinceLast: 0,
      seq: 1,
      lastSavedSeq: 1,
      lastSavedAt: 100,
    };
    const [after, cmds] = snap.confirm(s, snapshotSaved(1, 999));
    expect(after).toEqual(s);
    expect(cmds).toEqual([]);
  });
});

describe("boot — resume after reload", () => {
  it("resets the cadence counter but preserves the durable watermark", () => {
    const snap = createSnapshot<RunState>({ every: 10 });
    // Pre-crash: 4 units accumulated since the last (confirmed) checkpoint.
    const pre: SnapshotState = {
      sinceLast: 4,
      seq: 3,
      lastSavedSeq: 3,
      lastSavedAt: 700,
    };
    const [resumed, cmds] = snap.boot(pre);
    // A resume emits nothing — uniform reducer-cell shape with `Cmd.none`.
    expect(cmds).toEqual([]);
    expect(resumed).toEqual({
      sinceLast: 0,
      seq: 3,
      lastSavedSeq: 3,
      lastSavedAt: 700,
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Machine-level: splice the knob into a real machine and drive it via `replay`
// through the testing helpers. Proves the verbs compose as reducer cells and
// the emitted Cmd lands in the runtime's cmd stream.
// ───────────────────────────────────────────────────────────────────────────

type State = { readonly run: RunState; readonly snap: SnapshotState };
type Msg =
  | { readonly type: "progress"; readonly at: number }
  | { readonly type: "finish"; readonly at: number }
  | {
      readonly type: "snapshot_saved";
      readonly seq: number;
      readonly at: number;
    }
  | {
      readonly type: "snapshot_failed";
      readonly seq: number;
      readonly error: unknown;
    };

const knob = createSnapshot<RunState>({ every: 2, key: "run/cp" });

const update: Reducer<State, Msg, Cmd> = {
  progress: (s, msg) => {
    const run = { step: s.run.step + 1 };
    const [snap, cmds] = knob.record(s.snap, run, msg.at);
    return [{ run, snap }, cmds];
  },
  finish: (s, msg) => {
    const [snap, cmds] = knob.force(s.snap, s.run, msg.at);
    return [{ ...s, snap }, cmds];
  },
  snapshot_saved: (s, msg) => {
    const [snap, cmds] = knob.confirm(s.snap, msg);
    return [{ ...s, snap }, cmds];
  },
  snapshot_failed: (s) => [s, []],
};

const machine = defineMachine<State, Msg, Cmd, never, undefined>({
  init: (loaded) =>
    loaded ? [loaded, []] : [{ run: { step: 0 }, snap: knob.init() }, []],
  update,
});

describe("snapshot knob spliced into a machine", () => {
  const m = bindMachine(machine, undefined);

  it("emits a write only every `every`-th progress, carrying the live payload", () => {
    // Two progress msgs at cadence 2 → exactly one write, payload = step 2.
    m.expectCmdSequence(
      {
        msgs: [
          { type: "progress", at: 1 },
          { type: "progress", at: 2 },
        ],
      },
      [
        {
          type: "snapshot_write",
          key: "run/cp",
          seq: 1,
          at: 2,
          payload: { step: 2 },
        },
      ],
    );
  });

  it("force on finish checkpoints the terminal state the cadence would miss", () => {
    // One progress (below cadence, no write) then finish → a forced write.
    m.expectCmdSequence(
      {
        msgs: [
          { type: "progress", at: 1 },
          { type: "finish", at: 9 },
        ],
      },
      [
        {
          type: "snapshot_write",
          key: "run/cp",
          seq: 1,
          at: 9,
          payload: { step: 1 },
        },
      ],
    );
  });

  it("a snapshot_saved Msg advances the durable watermark in the final state", () => {
    const { state } = m.replay({
      msgs: [
        { type: "progress", at: 1 },
        { type: "progress", at: 2 }, // seq 1 write emitted
        { type: "snapshot_saved", seq: 1, at: 5 },
      ],
    });
    expect(state.snap.lastSavedSeq).toBe(1);
    expect(state.snap.lastSavedAt).toBe(5);
    expect(state.snap.seq).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Handlers: the I/O boundary. Drive the `snapshot_write` interpret cell against
// a fake R2/KV-shaped store and assert it puts + routes Ok/Err to the right Msg.
// ───────────────────────────────────────────────────────────────────────────

describe("handlers — the write effect", () => {
  function fakeStore<V>(): SnapshotStore<V> & {
    puts: { key: string; value: V }[];
  } {
    const cell = new Map<string, V>();
    const puts: { key: string; value: V }[] = [];
    return {
      puts,
      async get(key) {
        return cell.has(key) ? (cell.get(key) as V) : null;
      },
      async put(key, value) {
        cell.set(key, value);
        puts.push({ key, value });
      },
    };
  }

  it("puts the payload under the Cmd's key and dispatches snapshot_saved on success", async () => {
    const store = fakeStore<RunState>();
    const handlers = knob.handlers({ store });
    const cmd: SnapshotWriteCmd<RunState> = {
      type: "snapshot_write",
      key: "run/cp",
      seq: 7,
      at: 1234,
      payload: { step: 42 },
    };

    const follow = await handlers.snapshot_write(cmd, {} as never);

    expect(store.puts).toEqual([{ key: "run/cp", value: { step: 42 } }]);
    expect(await store.get("run/cp")).toEqual({ step: 42 });
    // Ok routes to snapshot_saved echoing the Cmd's seq + at — feeds `confirm`.
    expect(follow).toEqual(snapshotSaved(7, 1234));
  });

  it("dispatches snapshot_failed (never throws) when the put rejects", async () => {
    const boom = new Error("KV write failed");
    const store: SnapshotStore<RunState> = {
      async get() {
        return null;
      },
      async put() {
        throw boom;
      },
    };
    const handlers = knob.handlers({ store });
    const cmd: SnapshotWriteCmd<RunState> = {
      type: "snapshot_write",
      key: "run/cp",
      seq: 3,
      at: 99,
      payload: { step: 1 },
    };

    // Railway: the handler resolves with an error Msg, it does not reject.
    const follow = await handlers.snapshot_write(cmd, {} as never);
    expect(follow).toEqual(snapshotFailed(3, boom));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Properties: the two invariants that must hold across arbitrary drives.
// ───────────────────────────────────────────────────────────────────────────

describe("record property: a write fires exactly every `every`-th unit", () => {
  it("over N progress units, the write count is floor(N / every)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }), // every
        fc.integer({ min: 0, max: 500 }), // number of progress units
        (every, n) => {
          const snap = createSnapshot<RunState>({ every });
          let s = snap.init();
          let writes = 0;
          for (let i = 0; i < n; i++) {
            const [next, cmds] = snap.record(s, { step: i }, i);
            s = next;
            writes += cmds.length;
            // Each record emits 0 or 1 Cmd — never more.
            if (cmds.length > 1) return false;
          }
          // sinceLast is always a valid residue in [0, every).
          return (
            writes === Math.floor(n / every) &&
            s.sinceLast >= 0 &&
            s.sinceLast < every
          );
        },
      ),
    );
  });
});

describe("confirm property: lastSavedSeq is monotonically non-decreasing", () => {
  it("never regresses under any interleaving of acks", () => {
    fc.assert(
      fc.property(
        // A stream of seqs to acknowledge in arbitrary order, including dups.
        fc.array(fc.integer({ min: 0, max: 50 }), { maxLength: 100 }),
        (acks) => {
          const snap = createSnapshot<RunState>({ every: 1 });
          // Seed seq high enough that any ack is plausibly "in range".
          let s: SnapshotState = {
            sinceLast: 0,
            seq: 50,
            lastSavedSeq: null,
            lastSavedAt: null,
          };
          let prev = -Infinity;
          for (const seq of acks) {
            const [next, cmds] = snap.confirm(s, snapshotSaved(seq, seq * 10));
            s = next;
            if (cmds.length !== 0) return false; // an ack must emit nothing
            const watermark = s.lastSavedSeq ?? -Infinity;
            if (watermark < prev) return false; // regressed — invariant broken
            prev = watermark;
          }
          return true;
        },
      ),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// DURABILITY GUARD — the package-wide invariant. Every reachable slice this
// module can settle into must round-trip through JSON unchanged: the slice
// rides inside the consumer's `Store<S>` blob and a DO eviction/reload must
// resurrect a byte-identical slice, or the cadence/watermark bookkeeping
// silently corrupts on the next boot. Snapshot's slice is plain data (numbers +
// null), so this drives EVERY verb that mutates the slice (record / force /
// confirm / boot — `requestLoad` leaves it unchanged) in arbitrary order and
// asserts JSON-stability at every step, with the final slice being the terminal
// one a reload would persist.
// ───────────────────────────────────────────────────────────────────────────

describe("durability property: every reachable slice round-trips through JSON unchanged", () => {
  it("JSON.parse(JSON.stringify(slice)) deep-equals the slice for every reachable terminal slice", () => {
    // A verb op over the slice. `requestLoad` is excluded — it returns the slice
    // unchanged, so it adds no reachable state, only an emitted Cmd.
    type Op =
      | { readonly kind: "record"; readonly step: number; readonly at: number }
      | { readonly kind: "force"; readonly step: number; readonly at: number }
      | { readonly kind: "confirm"; readonly seq: number; readonly at: number }
      | { readonly kind: "boot" };

    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.record({
        kind: fc.constant("record" as const),
        step: fc.integer({ min: 0, max: 1000 }),
        at: fc.integer({ min: 0, max: 1_000_000 }),
      }),
      fc.record({
        kind: fc.constant("force" as const),
        step: fc.integer({ min: 0, max: 1000 }),
        at: fc.integer({ min: 0, max: 1_000_000 }),
      }),
      fc.record({
        kind: fc.constant("confirm" as const),
        seq: fc.integer({ min: 0, max: 100 }),
        at: fc.integer({ min: 0, max: 1_000_000 }),
      }),
      fc.record({ kind: fc.constant("boot" as const) }),
    );

    const assertRoundTrips = (slice: SnapshotState) => {
      const roundTripped = JSON.parse(JSON.stringify(slice));
      expect(roundTripped).toEqual(slice);
    };

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.array(opArb, { maxLength: 200 }),
        (every, ops) => {
          const snap = createSnapshot<RunState>({ every });
          let s = snap.init();
          // The initial slice is itself a reachable terminal slice.
          assertRoundTrips(s);
          for (const op of ops) {
            switch (op.kind) {
              case "record":
                [s] = snap.record(s, { step: op.step }, op.at);
                break;
              case "force":
                [s] = snap.force(s, { step: op.step }, op.at);
                break;
              case "confirm":
                [s] = snap.confirm(s, snapshotSaved(op.seq, op.at));
                break;
              case "boot":
                [s] = snap.boot(s);
                break;
            }
            // Every intermediate slice is a slice a reload could persist; the
            // final iteration's slice is the terminal one. All must round-trip.
            assertRoundTrips(s);
          }
          return true;
        },
      ),
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Recovery — the read half. `requestLoad` emits the read Cmd; the `snapshot_load`
// handler reads `store.get(key)` and routes Ok (payload-or-null) / Err to the
// right Msg. Without this loop a checkpoint is a backup, not a restart point —
// the module's reason to exist.
// ───────────────────────────────────────────────────────────────────────────

describe("requestLoad — emits the read Cmd", () => {
  it("emits a snapshot_load carrying the configured key, slice unchanged", () => {
    const snap = createSnapshot<RunState>({ every: 5, key: "run/cp" });
    const before: SnapshotState = {
      sinceLast: 3,
      seq: 2,
      lastSavedSeq: 2,
      lastSavedAt: 400,
    };
    const [after, cmds] = snap.requestLoad(before);
    // A read decides nothing about the cadence bookkeeping.
    expect(after).toEqual(before);
    expect(cmds).toEqual([{ type: "snapshot_load", key: "run/cp" }]);
  });

  it("defaults the read key to @@snapshot when omitted", () => {
    const snap = createSnapshot<RunState>({ every: 1 });
    const [, cmds] = snap.requestLoad(snap.init());
    expect((cmds[0] as SnapshotLoadCmd).key).toBe("@@snapshot");
  });
});

describe("handlers — the read effect", () => {
  it("gets the payload under the Cmd's key and dispatches snapshot_loaded", async () => {
    const store: SnapshotStore<RunState> = {
      async get(key) {
        return key === "run/cp" ? { step: 99 } : null;
      },
      async put() {},
    };
    const handlers = knob.handlers({ store });
    const cmd: SnapshotLoadCmd = { type: "snapshot_load", key: "run/cp" };

    const follow = await handlers.snapshot_load(cmd, {} as never);
    expect(follow).toEqual(snapshotLoaded({ step: 99 }));
  });

  it("dispatches snapshot_loaded(null) when the store has no checkpoint", async () => {
    const store: SnapshotStore<RunState> = {
      async get() {
        return null;
      },
      async put() {},
    };
    const handlers = knob.handlers({ store });
    const cmd: SnapshotLoadCmd = { type: "snapshot_load", key: "run/cp" };

    const follow = await handlers.snapshot_load(cmd, {} as never);
    // null is "no checkpoint yet" — a normal first-run state, not an error.
    expect(follow).toEqual(snapshotLoaded(null));
    expect((follow as SnapshotLoadedMsg<RunState>).payload).toBeNull();
  });

  it("dispatches snapshot_load_failed (never throws) when the get rejects", async () => {
    const boom = new Error("KV read failed");
    const store: SnapshotStore<RunState> = {
      async get() {
        throw boom;
      },
      async put() {},
    };
    const handlers = knob.handlers({ store });
    const cmd: SnapshotLoadCmd = { type: "snapshot_load", key: "run/cp" };

    // Railway: the handler resolves with an error Msg, it does not reject.
    const follow = await handlers.snapshot_load(cmd, {} as never);
    expect(follow).toEqual(snapshotLoadFailed(boom));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// WIRED end-to-end recovery. This is the test class that was missing — the one
// `replay` cannot express, because `replay` never calls interpret. Here we drive
// a REAL `run(...)` runtime: a `boot` Msg folds `requestLoad`, the runtime
// performs the emitted `snapshot_load` Cmd against a real fake store, the
// handler's `snapshot_loaded` follow-up RE-ENTERS the machine, and the
// consumer's reducer folds the recovered payload into the run slice. We assert
// the END STATE — the run state actually recovered from the durable checkpoint —
// never the intermediate Msgs we hand-fed.
//
// Against the buggy code (no `requestLoad`, no `snapshot_load` handler), the
// `boot` cell cannot emit a read, no checkpoint is ever read back, and the run
// slice stays at the fresh `init` value — the assertion fails. That is exactly
// why the bug shipped green under `replay`-only tests.
// ───────────────────────────────────────────────────────────────────────────

describe("WIRED: restart-from-checkpoint through a real runtime", () => {
  // The recovery-aware host machine. `boot` triggers the read; `snapshot_loaded`
  // folds the recovered payload (or keeps fresh init on null); the run slice is
  // the durable thing being checkpointed.
  type RecState = { readonly run: RunState; readonly snap: SnapshotState };
  type RecMsg =
    | { readonly type: "boot" }
    | { readonly type: "progress"; readonly at: number }
    | SnapshotSavedMsg
    | SnapshotLoadedMsg<RunState>
    | SnapshotLoadFailedMsg;

  // A real R2/KV-shaped fake store backed by a Map, plus a recorder of failures.
  function makeStore(seed?: {
    key: string;
    value: RunState;
  }): SnapshotStore<RunState> {
    const cell = new Map<string, RunState>();
    if (seed) cell.set(seed.key, seed.value);
    return {
      async get(key) {
        return cell.has(key) ? (cell.get(key) as RunState) : null;
      },
      async put(key, value) {
        cell.set(key, value);
      },
    };
  }

  function recoveryMachine(store: SnapshotStore<RunState>) {
    const recKnob = createSnapshot<RunState>({ every: 2, key: "run/cp" });
    const update: Reducer<RecState, RecMsg, Cmd> = {
      // Resume: ask the durable store for the last checkpoint.
      boot: (s) => {
        const [snap, cmds] = recKnob.requestLoad(s.snap);
        return [{ ...s, snap }, cmds];
      },
      progress: (s, msg) => {
        const runNext = { step: s.run.step + 1 };
        const [snap, cmds] = recKnob.record(s.snap, runNext, msg.at);
        return [{ run: runNext, snap }, cmds];
      },
      // The recovery fold: a non-null payload seeds the run slice from the
      // durable checkpoint; null keeps the fresh init.
      snapshot_loaded: (s, msg) => {
        if (msg.payload === null) return [s, []];
        const [snap, cmds] = recKnob.boot(s.snap);
        return [{ run: msg.payload, snap }, cmds];
      },
      snapshot_saved: (s, msg) => {
        const [snap, cmds] = recKnob.confirm(s.snap, msg);
        return [{ ...s, snap }, cmds];
      },
      snapshot_load_failed: (s) => [s, []],
    };
    return defineMachine<RecState, RecMsg, Cmd, never, undefined>({
      // Fresh init — step 0. Recovery overwrites this via snapshot_loaded.
      init: (loaded) =>
        loaded
          ? [loaded, []]
          : [{ run: { step: 0 }, snap: recKnob.init() }, []],
      update,
      interpret: { ...recKnob.handlers({ store }) },
    });
  }

  it("recovers the checkpointed run state: a fresh boot + dispatch(boot) restores step from the store", async () => {
    // The store already holds a checkpoint from a previous (crashed) run.
    const store = makeStore({ key: "run/cp", value: { step: 17 } });
    const runtime = await run(recoveryMachine(store), { ctx: undefined }).ready;

    // Fresh init started at step 0 — prove the precondition.
    expect(runtime.getState().run.step).toBe(0);

    // Drive the REAL recovery loop: boot → snapshot_load Cmd → store.get →
    // snapshot_loaded follow-up re-enters → fold. `stop()` drains the tail so
    // the fire-and-forget follow-up has fully landed before we read.
    await runtime.dispatch({ type: "boot" });
    await runtime.stop();

    // END STATE: the run slice was restored FROM THE DURABLE CHECKPOINT, not
    // left at the fresh-init step 0. This is the assertion the buggy code fails.
    expect(runtime.getState().run.step).toBe(17);
  });

  it("keeps the fresh-init state when the store has no checkpoint (null payload)", async () => {
    const store = makeStore(); // empty — no prior checkpoint
    const runtime = await run(recoveryMachine(store), { ctx: undefined }).ready;

    await runtime.dispatch({ type: "boot" });
    await runtime.stop();

    // No checkpoint → recovery is a no-op → fresh init survives.
    expect(runtime.getState().run.step).toBe(0);
  });

  it("write then recover round-trips through the store: a checkpointed run resumes at the same step", async () => {
    const store = makeStore();

    // Phase 1: a run that checkpoints. every:2 → the 2nd progress writes step 2.
    const writer = await run(recoveryMachine(store), { ctx: undefined }).ready;
    await writer.dispatch({ type: "progress", at: 1 });
    await writer.dispatch({ type: "progress", at: 2 }); // emits snapshot_write(step 2)
    await writer.stop(); // drains the write → store now holds { step: 2 }

    // Phase 2: a brand-new runtime (simulating a restart) recovers from the
    // durable checkpoint the first run left behind.
    const restarted = await run(recoveryMachine(store), { ctx: undefined })
      .ready;
    expect(restarted.getState().run.step).toBe(0); // fresh before recovery
    await restarted.dispatch({ type: "boot" });
    await restarted.stop();

    // The restart resumed at the checkpointed step — the whole point of the module.
    expect(restarted.getState().run.step).toBe(2);
  });
});
