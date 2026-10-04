// Type-level test for #568: `SpawnSteps.notify` cannot fail. `spawn` runs it
// on a fiber nothing reads, so a `tell` passed bare, with its `StoreFailed`
// unhandled, is a compile error. Compiled by `pnpm typecheck`; every
// `@ts-expect-error` must sit on a line that fails.

import { Effect } from "effect";
import { defineMachine } from "../index";
import { type EffectRuntime, type SpawnSteps, tell } from "./index";

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
  // @ts-expect-error a `tell` fails with `StoreFailed`, and `notify` cannot fail
  notify: tell(parent, parentRun, msg),
};

const handled: SpawnSteps<void> = {
  ...rest,
  notify: tell(parent, parentRun, msg).pipe(
    Effect.catch((failure) => Effect.logError(failure)),
  ),
};

const died: SpawnSteps<void> = {
  ...rest,
  notify: Effect.orDie(tell(parent, parentRun, msg)),
};

void [bare, handled, died];
