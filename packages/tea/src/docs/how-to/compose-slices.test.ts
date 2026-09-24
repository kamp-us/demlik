/**
 * The compose-two-battery-slices recipe's compile-and-run gate (#240).
 *
 * `docs/how-to/compose-two-battery-slices.md` hands the reader a two-battery
 * door to paste. Two of its claims cannot survive a page nothing compiles: that
 * `liftSlice`'s key is checked against the host Model, so threading one
 * battery's slice into the other's field is a compile error rather than a state
 * shape nothing reads correctly; and that `readInOrder`'s precedence is a VALUE,
 * so reshuffling it changes an answer a test can name.
 *
 * So the door lives HERE, as real TypeScript in the test program
 * (`tsconfig.test.json`, gated in CI as `typecheck:test`), and the tests below
 * assert the page's `ts` blocks are this file's `#region` bodies verbatim. The
 * page cannot drift from a compiling artifact, because the page IS the
 * artifact. The composed read is then driven through the real reducer, and the
 * reshuffle test folds the SAME state through a flipped `ANSWER_ORDER` so the
 * precedence has a failing assertion behind it and not only a comment.
 */

// biome-ignore-all assist/source/organizeImports: the `#region` markers below
// pin import blocks the page reproduces verbatim; sorting the harness's imports
// into them would move a marker and break the assertions this file is.
// biome-ignore-all lint/suspicious/noExportsInTest: the door is the artifact
// under test, and it is exported because the reader pastes it as a module.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #region batteries
/**
 * Two batteries, each pure state plus verbs over that state, and neither one
 * aware the other exists. A verb returns `readonly [Slice, readonly Cmd[]]` —
 * its own slice and the Cmds it wants run — which is the shape `liftSlice`
 * threads back into a host.
 */

/** What a lookup settled on, once it has. */
export type Answer = { readonly title: string };

/** Battery one: answers already settled, by key. */
export type CacheSlice = Readonly<Record<string, Answer>>;

export const cache = {
  init: (): CacheSlice => ({}),
  remember: (
    slice: CacheSlice,
    key: string,
    answer: Answer,
  ): readonly [CacheSlice, readonly never[]] => [
    { ...slice, [key]: answer },
    [],
  ],
};

/** Battery two: the keys a request is out for, with the instant it left. */
export type InFlightSlice = Readonly<Record<string, number>>;

export const inFlight = {
  init: (): InFlightSlice => ({}),
  begin: (
    slice: InFlightSlice,
    key: string,
    at: number,
  ): readonly [InFlightSlice, readonly never[]] => [
    { ...slice, [key]: at },
    [],
  ],
  end: (
    slice: InFlightSlice,
    key: string,
  ): readonly [InFlightSlice, readonly never[]] => {
    const { [key]: _gone, ...rest } = slice;
    return [rest, []];
  },
};
// #endregion batteries

// #region door
import { defineMachine, liftSlice } from "@demlik/tea";

/**
 * The door: one Model carrying both slices at named keys, plus whatever the
 * host itself owns. The batteries never see this type, and it never sees
 * theirs — the two meet only at the key.
 */
export interface LookupState {
  readonly cache: CacheSlice;
  readonly inFlight: InFlightSlice;
  readonly asked: number;
}

export type LookupMsg =
  | { readonly type: "ask"; readonly key: string; readonly at: number }
  | { readonly type: "arrived"; readonly key: string; readonly answer: Answer };

/**
 * `liftSlice(key, state, verb(...))` is the `{ ...state, inFlight: slice }`
 * every consumer writes by hand, with the key checked: pass `"cache"` here and
 * the `InFlightSlice` the verb returned is not assignable to the field, so it
 * fails to compile instead of producing a Model whose reads quietly stop
 * agreeing.
 */
export const lookup = defineMachine({
  types: { model: {} as LookupState, msg: {} as LookupMsg },
  init: (loaded) =>
    loaded !== null
      ? [loaded, []]
      : [{ cache: cache.init(), inFlight: inFlight.init(), asked: 0 }, []],
  update: {
    ask: (s, m) =>
      liftSlice(
        "inFlight",
        { ...s, asked: s.asked + 1 },
        inFlight.begin(s.inFlight, m.key, m.at),
      ),
    arrived: (s, m) => {
      // Two verbs, one Msg: lift each into its own key, threading the state
      // through. The Cmds each one returned come back beside it — here both
      // batteries are pure bookkeeping and emit none.
      const [ended] = liftSlice("inFlight", s, inFlight.end(s.inFlight, m.key));
      return liftSlice(
        "cache",
        ended,
        cache.remember(s.cache, m.key, m.answer),
      );
    },
  },
});
// #endregion door

// #region read
import { type ReadStep, readInOrder } from "@demlik/tea";

/** What the door says about one key, for a caller that has to render something. */
export type Status =
  | { readonly state: "ready"; readonly title: string }
  | { readonly state: "pending"; readonly since: number }
  | { readonly state: "unknown" };

/**
 * The precedence, as data. A key that is BOTH cached and in flight is `ready` —
 * a refresh in the background does not un-answer the answer you already have —
 * and that fact lives in the order of this array, where a test can name it,
 * rather than in the order of two `if` statements, where nothing can.
 *
 * `name` is what makes it nameable: `ANSWER_ORDER.map((s) => s.name)` is the
 * precedence, printable in a log and assertable in a test.
 */
export const ANSWER_ORDER = (
  s: LookupState,
): readonly ReadStep<string, Status>[] => [
  {
    name: "cache",
    read: (key) => {
      const hit = s.cache[key];
      return hit === undefined
        ? undefined
        : { state: "ready", title: hit.title };
    },
  },
  {
    name: "inFlight",
    read: (key) => {
      const since = s.inFlight[key];
      return since === undefined ? undefined : { state: "pending", since };
    },
  },
];

/** The derived read itself: first step with something to say wins. */
export const statusOf = (s: LookupState, key: string): Status =>
  readInOrder(key, ANSWER_ORDER(s), { state: "unknown" });
// #endregion read

// ---------------------------------------------------------------------------
// It runs.
// ---------------------------------------------------------------------------

import { applyCell } from "@demlik/tea";

/** One step of the real reducer — the cell lookup the runtime itself does. */
const step = (s: LookupState, m: LookupMsg): LookupState =>
  applyCell<LookupState, LookupMsg, never>(lookup, s, m)[0];

const zero: LookupState = {
  cache: cache.init(),
  inFlight: inFlight.init(),
  asked: 0,
};

/** The state after asking for `tea` and having the answer come back. */
const settled = (): LookupState =>
  step(step(zero, { type: "ask", key: "tea", at: 7 }), {
    type: "arrived",
    key: "tea",
    answer: { title: "Tea" },
  });

describe("docs/how-to/compose-two-battery-slices.md (#240) — it runs", () => {
  it("threads each verb result into its own key and leaves the sibling alone", () => {
    const asked = step(zero, { type: "ask", key: "tea", at: 7 });

    expect(asked.inFlight).toEqual({ tea: 7 });
    // `liftSlice` rebuilt one key; the cache slice is the SAME value, by
    // identity, which is the whole promise of a one-key record rebuild.
    expect(asked.cache).toBe(zero.cache);
    expect(asked.asked).toBe(1);
  });

  it("reads `unknown` for a key neither battery knows", () => {
    expect(statusOf(zero, "tea")).toEqual({ state: "unknown" });
  });

  it("reads `pending` from the second step while the first defers", () => {
    const asked = step(zero, { type: "ask", key: "tea", at: 7 });
    expect(statusOf(asked, "tea")).toEqual({ state: "pending", since: 7 });
  });

  it("reads `ready` once the answer has landed", () => {
    expect(statusOf(settled(), "tea")).toEqual({
      state: "ready",
      title: "Tea",
    });
  });
});

describe("docs/how-to/compose-two-battery-slices.md (#240) — the precedence", () => {
  /** Cached AND back in flight: the one input the two orders disagree about. */
  const refreshing = (): LookupState =>
    step(settled(), { type: "ask", key: "tea", at: 9 });

  // #region precedence
  it("answers `ready` for a cached key that is refreshing", () => {
    const s = refreshing();

    // The order itself, by name. A reshuffle changes this line too, so the
    // test says which precedence it is asserting and not only what it got.
    expect(ANSWER_ORDER(s).map((entry) => entry.name)).toEqual([
      "cache",
      "inFlight",
    ]);
    // …and the answer that order produces. Swap the two entries in
    // `ANSWER_ORDER` and this assertion fails with `pending`.
    expect(statusOf(s, "tea")).toEqual({ state: "ready", title: "Tea" });
  });
  // #endregion precedence

  it("reads `pending` over that same state once the order is flipped", () => {
    const flipped = [...ANSWER_ORDER(refreshing())].reverse();
    const absent: Status = { state: "unknown" };

    expect(flipped.map((entry) => entry.name)).toEqual(["inFlight", "cache"]);
    expect(readInOrder("tea", flipped, absent)).toEqual({
      state: "pending",
      since: 9,
    });
  });
});

// ---------------------------------------------------------------------------
// It cannot rot.
// ---------------------------------------------------------------------------

const page = fileURLToPath(
  new URL(
    "../../../docs/how-to/compose-two-battery-slices.md",
    import.meta.url,
  ),
);
const self = fileURLToPath(import.meta.url);

/** The text between one region's markers, which is what the page shows. */
async function region(name: string): Promise<string> {
  const source = await readFile(self, "utf8");
  const body = source
    .split(`// #region ${name}\n`)[1]
    ?.split(`// #endregion ${name}\n`)[0];
  if (body === undefined)
    throw new Error(`the ${name} region markers are gone`);
  return body.trimEnd();
}

/** Every fenced ```ts block on the page, in page order. */
async function tsBlocks(): Promise<string[]> {
  const markdown = await readFile(page, "utf8");
  return [...markdown.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) =>
    (m[1] ?? "").trimEnd(),
  );
}

describe("docs/how-to/compose-two-battery-slices.md (#240) — it cannot rot", () => {
  it.each([
    "batteries",
    "door",
    "read",
    "precedence",
  ])("shows the compiled `%s` block verbatim", async (name) => {
    expect(await tsBlocks()).toContain(await region(name));
  });
});
