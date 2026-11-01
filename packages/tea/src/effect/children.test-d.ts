// Type-level test for #568, #639 and #782: `SpawnSteps.notify` cannot fail,
// because `spawn` runs it on a fiber nothing reads, and `tell` carries no failure,
// so it goes in bare. `tell` takes only a handle that came from `run`, so a
// `notify` over a hand-built one does not compile. Compiled by `pnpm typecheck`;
// every `@ts-expect-error` must sit on a line that fails.

import { Effect } from "effect";
import { defineMachine } from "../index";
import {
  type EffectBootingRun,
  type EffectBootingRuntime,
  type EffectRun,
  type EffectRuntime,
  run,
  type SpawnSteps,
  type TellAnswer,
  tell,
} from "./index";

type ParentState = { readonly stopped: readonly string[] };
type ParentMsg = { readonly type: "child_stopped"; readonly id: string };
const parent = defineMachine({
  types: { model: {} as ParentState, msg: {} as ParentMsg },
  init: (loaded) => [loaded ?? { stopped: [] }, []],
  update: {
    child_stopped: (s, m) => [{ stopped: [...s.stopped, m.id] }, []],
  },
});

declare const parentRun: EffectRun<ParentState, ParentMsg>;
declare const fromRun: EffectBootingRun<ParentState, ParentMsg>;
declare const handBuilt: EffectRuntime<ParentState, ParentMsg>;
declare const handBuiltBooting: EffectBootingRuntime<ParentState, ParentMsg>;
const msg = { type: "child_stopped", id: "a" } as const;

const rest = {
  start: () => Effect.void,
  enrol: () => Effect.void,
  remove: Effect.void,
};

const bare: SpawnSteps<void> = {
  ...rest,
  notify: tell(parent, parentRun, msg),
};

const failing: SpawnSteps<void> = {
  ...rest,
  // @ts-expect-error `notify` cannot fail
  notify: Effect.fail("no parent" as const),
};

// The answer is the whole of what `tell` says: three words, no failure.
const answered: Effect.Effect<"queued" | "stopped" | "no_cell", never> = tell(
  parent,
  parentRun,
  msg,
);
// A save failure back in the failure channel breaks this line, `answered` and `bare`.
const named: Effect.Effect<TellAnswer, never> = tell(parent, parentRun, msg);

// One parent, three spawned children, each stop told to the parent: the hand-built
// parent cannot be written, so no child's notice is lost to it.
const notices = (["a", "b", "c"] as const).map((id) => ({
  real: { ...rest, notify: tell(parent, parentRun, { ...msg, id }) },
  spread: { ...rest, notify: tell(parent, { ...parentRun }, { ...msg, id }) },
  // @ts-expect-error a parent handle built by hand has no line
  handBuilt: { ...rest, notify: tell(parent, handBuilt, { ...msg, id }) },
  // @ts-expect-error a spread of a hand-built parent handle has no line either
  spreadOfHandBuilt: { notify: tell(parent, { ...handBuilt }, { ...msg, id }) },
}));

// A handle from `run`, one from `ready`, and a spread of either.
const fromProgram = Effect.gen(function* () {
  const booting = yield* run(parent, {});
  const booted = yield* booting.ready;
  yield* tell(parent, booting, msg);
  yield* tell(parent, booted, msg);
  yield* tell(parent, { ...booting }, msg);
  yield* tell(parent, { ...booted }, msg);
  // A real handle still fits where the plain types are asked for.
  const plain: EffectRuntime<ParentState, ParentMsg> = booted;
  const plainBooting: EffectBootingRuntime<ParentState, ParentMsg> = booting;
  return [plain, plainBooting];
});
const spreadOfBooting = tell(parent, { ...fromRun }, msg);

// @ts-expect-error a booting handle not known to come from `run` has no line
const handBuiltAnswer = tell(parent, handBuiltBooting, msg);

void [
  bare,
  failing,
  answered,
  named,
  notices,
  fromProgram,
  spreadOfBooting,
  handBuiltAnswer,
];
