/**
 * bootResume — the generalized cold-wake resume dispatch (issue #231).
 *
 * Mirrors the `autoBoot` / `step-host` wake → resume → hibernate coverage, but
 * for a NON-agent durable machine wired through `bootResume` with its own typed
 * resume-Msg port. The load-bearing claim: a machine that rehydrated mid-loop
 * re-derives its next step on cold wake WITHOUT re-firing already-folded effects
 * — exactly one outstanding effect re-fires, the completed ones stay folded.
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported.
 */
import { describe, expect, it } from "vitest";
import { type Cmd, defineMachine, run, type Store } from "../index";
import { bootResume, type ResumePort } from "./host";

// A minimal non-agent durable grain: it processes one unit of work at a time.
// `done` counts UNITS ALREADY FOLDED (durable, must NOT replay on wake);
// `inFlight` is the single outstanding effect a mid-loop rehydrate must re-fire;
// `resumedAt` records the clock the resume Msg carried (proves the typed port
// threaded `now`).
type WorkerState = {
  readonly done: number;
  readonly inFlight: boolean;
  readonly resumedAt: number | null;
};

const FRESH: WorkerState = { done: 0, inFlight: false, resumedAt: null };

type BeginMsg = { readonly type: "begin" };
type WorkDoneMsg = { readonly type: "work_done" };
// The typed resume Msg — the `AgentBootMsg` shape (issue #60) for this grain.
type ResumeMsg = { readonly type: "resume_work"; readonly at: number };
type WorkerMsg = BeginMsg | WorkDoneMsg | ResumeMsg;

type DoWorkCmd = Cmd<"do_work">;

// The typed resume-Msg port constructor — never a hand-built literal (AC #3).
const resumeWorkMsg = (at: number): ResumeMsg => ({ type: "resume_work", at });

// A durable machine wired through `bootResume`: its resume port is the grain's
// own predicate + typed constructor, the direct non-agent analogue of
// `autoBoot`'s `{ isResumable: agentIsResumable, resumeMsg: agentBootMsg }`.
const workerResumePort: ResumePort<WorkerState, WorkerMsg> = {
  isResumable: (s) => s.inFlight,
  resumeMsg: resumeWorkMsg,
};

// Build a machine whose interpret pushes to a caller-owned effect log, so the
// test observes exactly how many times the effect fired across a wake.
function makeWorker(effects: number[]) {
  return defineMachine<
    WorkerState,
    WorkerMsg,
    DoWorkCmd,
    never,
    Record<never, never>
  >({
    // Rehydrate branch is PURE (zero Cmds) per Invariant 2 — the effect is
    // re-fired by `bootResume`, never by init. Fresh boot starts idle; work is
    // kicked by a `begin` Msg, not a boot Cmd.
    init: (loaded) => [loaded ?? FRESH, []],
    update: {
      begin: (s) => [{ ...s, inFlight: true }, [{ type: "do_work" }]],
      // The resume verb: re-emit the ONE outstanding effect and stamp the clock.
      // Guarded on `inFlight` so a spurious resume on a settled machine is inert.
      resume_work: (s, msg) =>
        s.inFlight
          ? [{ ...s, resumedAt: msg.at }, [{ type: "do_work" }]]
          : [s, []],
      work_done: (s) => [{ ...s, done: s.done + 1, inFlight: false }, []],
    },
    interpret: {
      do_work: async () => {
        effects.push(1);
        return { type: "work_done" };
      },
    },
  });
}

// A tiny in-memory `Store<S>` — `load` returns the seeded raw (null = fresh
// boot); `migrate` is the boundary parse. Stands in for `doStore` without a DO.
function memStore(seed: WorkerState | null): Store<WorkerState> {
  let cell: WorkerState | null = seed;
  return {
    async load() {
      return cell;
    },
    async save(state) {
      cell = state;
    },
    migrate(raw) {
      return (raw as WorkerState | null) ?? null;
    },
  };
}

describe("bootResume — cold-wake resume for a non-agent durable machine (#231)", () => {
  it("is a no-op on a fresh (non-rehydrated) machine", async () => {
    const effects: number[] = [];
    const booting = run(makeWorker(effects), { store: memStore(null) });
    await bootResume(booting, workerResumePort, () => 999);
    const runtime = await booting.ready;

    expect(runtime.getState()).toEqual(FRESH);
    // No outstanding effect on a fresh boot ⇒ nothing dispatched, nothing fired.
    expect(effects).toEqual([]);
    await runtime.stop();
  });

  it("resumes from durable State after eviction, re-firing exactly the one outstanding effect", async () => {
    const effects: number[] = [];
    // Persisted mid-loop: two units already completed & folded, one in flight.
    const evicted: WorkerState = { done: 2, inFlight: true, resumedAt: null };
    const booting = run(makeWorker(effects), { store: memStore(evicted) });

    await bootResume(booting, workerResumePort, () => 777);
    const runtime = await booting.ready;
    const state = runtime.getState();

    // The already-folded units are NOT replayed — only the single outstanding
    // effect re-fires, then folds to `done: 3` and clears `inFlight`.
    expect(effects).toEqual([1]);
    expect(state.done).toBe(3);
    expect(state.inFlight).toBe(false);
    // The typed resume port threaded the pinned clock through, proving the Msg
    // was built by the constructor (not a hand literal that would drop `at`).
    expect(state.resumedAt).toBe(777);
    await runtime.stop();
  });

  it("without bootResume, a rehydrated machine stays stuck — init emits zero Cmds (Invariant 2)", async () => {
    const effects: number[] = [];
    const evicted: WorkerState = { done: 2, inFlight: true, resumedAt: null };
    const booting = run(makeWorker(effects), { store: memStore(evicted) });

    // Boot WITHOUT the resume dispatch: the rehydrate branch fired no Cmd, so
    // nothing advances the in-flight unit. This is exactly the silent-broken
    // resume `bootResume` prevents.
    const runtime = await booting.ready;

    expect(effects).toEqual([]);
    expect(runtime.getState()).toEqual(evicted);
    await runtime.stop();
  });
});
