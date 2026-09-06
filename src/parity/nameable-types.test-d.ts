// Type-level test for the `@demlik/tea/parity` door's own signature types
// (#107). Compiled by `pnpm typecheck` (tsc over `src/**` INCLUDES
// `*.test-d.ts`), so if `Trace` or `RecorderOptions` stops being re-exported
// from this entry point, the build fails here rather than in a consumer.
//
// The recorder is internal, so this module is the ONLY door either type can be
// named through. Every import below therefore goes through `./index` — the
// entry point — never through `../internal/persistence/recorder`.

import type { Cmd, Machine } from "../index";
import {
  goldenReplay,
  type RecorderOptions,
  recordRun,
  type Trace,
} from "./index";

type State = { readonly count: number };
type Msg = { readonly type: "inc" };

declare const machine: Machine<State, Msg, Cmd, never, void>;

// `RecorderOptions` names a `recordRun` options object.
const opts: RecorderOptions = { captureSteps: true };
declare const runtime: Parameters<typeof recordRun<State, Msg>>[0];
const recording = recordRun(runtime, opts);

// `Trace` annotates a `goldenReplay` argument — the fixture case the how-to
// used to spell as `ReturnType<typeof rec.trace>`.
const golden: Trace<State, Msg> = recording.trace();
const replayed: State = goldenReplay(machine, golden);

// A wrapper can give itself an explicit return type, which is what an
// unnameable type made impossible.
export function snapshot(rec: typeof recording): Trace<State, Msg> {
  return rec.trace();
}

export const parityTypeSurface = { golden, replayed, opts };
