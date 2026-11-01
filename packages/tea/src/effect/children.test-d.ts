// Type-level test for #568 and #639: `SpawnSteps.notify` cannot fail, because
// `spawn` runs it on a fiber nothing reads, and `tell` carries no failure, so it
// goes in bare. Compiled by `pnpm typecheck`; every `@ts-expect-error` must sit
// on a line that fails.

import { Effect } from "effect";
import { defineMachine } from "../index";
import {
  type EffectRuntime,
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

declare const parentRun: EffectRuntime<ParentState, ParentMsg>;
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

void [bare, failing, answered, named];
