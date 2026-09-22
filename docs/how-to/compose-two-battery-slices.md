# Compose two battery slices into one door

You have two batteries — pure state plus verbs over that state — and one Model
that has to carry both. Two jobs fall out of that, and `@demlik/tea`'s root door
covers each with one function: `liftSlice` threads a verb's
`readonly [Slice, readonly Cmd[]]` result back into the host Model at a typed
key, and `readInOrder` turns a read spanning both slices into a precedence you
can name, export and assert on.

This guide wires a two-battery door end to end and reads across it. Each
function's own surface is in [the reference page](../reference/tea.md);
why this is forty lines here rather than a dependency is settled in
[ADR 0001](../../.decisions/0001-no-offtheshelf-resilience.md) and
[ADR 0014](../../.decisions/0014-typed-effect-channels-on-cmd-constructors.md) —
everything below is the wiring.

## 1. Start from two batteries that do not know about each other

A battery's verb takes its own slice and returns its own slice plus the Cmds it
wants run. It never takes the host Model, and it never names a field on it —
that ignorance is what lets one battery be mounted twice, or beside a battery
written by someone else.

```ts
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
```

Neither battery here emits a Cmd, so both return `[]`. A battery that does emit
one returns it in the same slot, and step 2 threads it through unchanged.

## 2. Thread each verb result back with `liftSlice`

The host Model carries each slice at a key it picks. `liftSlice(key, state,
result)` is the `{ ...state, inFlight: slice }` you would otherwise hand-write
per cell, with the key checked against the Model: the slice the verb returned
has to be assignable to the field `key` names, so swapping the two keys is a
compile error instead of a Model whose reads quietly stop agreeing.

```ts
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
```

Two lifts compose by threading the state: the first returns the next Model, and
the second lifts into that. Take the Cmds from the lift that produced them —
here both arrays are empty, so the `arrived` cell returns the second lift whole.

## 3. Make the derived read's precedence a value with `readInOrder`

A read that spans both slices has a precedence: a key that is cached *and* back
in flight is answered from the cache, because a background refresh does not
un-answer the answer you already hold. Written as two `if` statements that fact
is invisible to the type system and unnameable in a test. Written as an array of
`ReadStep`s it is a value.

Each step returns `undefined` to defer to the next one, and `readInOrder` returns
the `absent` value you pass when every step defers.

```ts
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
```

`ReadStep.name` is what makes the precedence printable and assertable —
`ANSWER_ORDER(s).map((step) => step.name)` is `["cache", "inFlight"]`, so a test
pins the order by name and a log line can say which slice answered.

## 4. Assert the order, not just the answer

Precedence is only tested by an input the two orders disagree about — for this
door, a key that is cached and refreshing at once. Fold to that state, then
assert the order by name beside the answer it produces:

```ts
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
```

Swap the two entries in `ANSWER_ORDER` and the second assertion fails with
`pending`. That is the property the whole shape buys: a reshuffle that used to
land silently now has a red test with the order printed beside it.

The driven version of all of this — the reducer folds behind `refreshing()`, and
the flipped order run over the same state — is in
`src/docs/how-to/compose-slices.test.ts`, which is also where the `ts` blocks
above live as compiling source.
