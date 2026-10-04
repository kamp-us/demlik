/**
 * Tracer test — the first tutorial's run.
 *
 * This RUNS the happy path `docs/tutorial/build-your-first-machine.md` teaches,
 * against the REAL public API — the assembled thing, not a stub.
 *
 * The how-to guides that used to be traced here from hand-kept copies are held
 * from their own page text now: `page-mirrors.ts` lists each page and the
 * compiled source it shows, and the test file beside each one runs it.
 *
 * Import style: the package's PUBLIC barrels, via the same source paths the
 * in-src tests already use (`../index`, `../promise`).
 *
 * Discipline (mirrors b8e's tracer): SHAPE assertions only — terminal-phase
 * equality, `toBeGreaterThan(0)` — never an exact run-length / message count.
 * Every block asserts the machine ADVANCED past its initial state, so a
 * silent-empty-green (a test that folded zero messages) is a hard fail.
 */

import { describe, expect, it } from "vitest";
import { defineMachine, replay } from "../index";
import { run } from "../promise";

// ───────────────────────────────────────────────────────────────────────────
// The TUTORIAL machine — a tiny download that reaches a terminal "done".
// A reader builds exactly this: Model + Msg + `update`, no Cmd, no Ctx.
// ───────────────────────────────────────────────────────────────────────────

type DlPhase = "idle" | "downloading" | "done";
interface DlState {
  readonly phase: DlPhase;
  readonly received: number;
  readonly total: number;
}
type DlMsg =
  | { readonly type: "start"; readonly total: number }
  | { readonly type: "chunk"; readonly size: number };

const downloader = defineMachine({
  types: { model: {} as DlState, msg: {} as DlMsg, ctx: undefined },
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [{ phase: "idle", received: 0, total: 0 }, []],
  update: {
    start: (s, m) => [
      { ...s, phase: "downloading", received: 0, total: m.total },
      [],
    ],
    chunk: (s, m) => {
      if (s.phase !== "downloading") return [s, []];
      const received = s.received + m.size;
      return received >= s.total
        ? [{ ...s, received: s.total, phase: "done" }, []]
        : [{ ...s, received }, []];
    },
  },
});

const dlDone = (s: DlState): boolean => s.phase === "done";
// The exact message sequence the tutorial dispatches, reused by `replay`.
const DL_MSGS: readonly DlMsg[] = [
  { type: "start", total: 3 },
  { type: "chunk", size: 1 },
  { type: "chunk", size: 1 },
  { type: "chunk", size: 1 },
];

describe("tutorial — build and replay your first machine", () => {
  it("runs to the terminal phase the lesson teaches", async () => {
    const runtime = await run(downloader, {
      ctx: undefined,
      terminal: dlDone,
    }).ready;

    expect(runtime.getState().phase).toBe("idle"); // initial
    for (const msg of DL_MSGS) await runtime.dispatch(msg);
    const final = await runtime.done();

    // advanced past init, reached the taught terminal
    expect(final.phase).toBe("done");
    expect(final.received).toBeGreaterThan(0);
    expect(final.received).toBe(final.total);
    await runtime.stop();
  });

  it("replay reproduces the SAME terminal Model — tea's determinism claim", async () => {
    const runtime = await run(downloader, {
      ctx: undefined,
      terminal: dlDone,
    }).ready;
    for (const msg of DL_MSGS) await runtime.dispatch(msg);
    const live = await runtime.done();
    await runtime.stop();

    // Pure replay of the same messages — no Store, no interpret, no subs.
    const { state: replayed } = replay(downloader, {
      msgs: DL_MSGS,
      ctx: undefined,
    });
    expect(replayed).toEqual(live); // determinism: same input → same Model
    expect(replayed.phase).toBe("done"); // and it genuinely advanced
  });
});
