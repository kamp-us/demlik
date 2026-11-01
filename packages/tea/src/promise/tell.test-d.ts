// Type-level test for #639 and #782: `tell` on the Promise engine answers with
// one of three words and nothing else, and it takes only a handle that came from
// `run`. Compiled by `pnpm typecheck`; every `@ts-expect-error` must sit on a
// line that fails.

import {
  type LineMsg,
  type LineState,
  line,
  ping,
} from "../__fixtures__/answering-machines";
import type { BootingRuntime, Runtime } from "../runtime-types";
import { noopRuntime } from "../testing";
import { type BootingRun, type Run, run, type TellAnswer, tell } from "./index";

declare const booted: Runtime<LineState, LineMsg>;
declare const booting: BootingRuntime<LineState, LineMsg>;
declare const fromRun: BootingRun<LineState, LineMsg>;
declare const fromReady: Run<LineState, LineMsg>;

const answer: TellAnswer = tell(line, fromReady, ping("a"));
const words: "queued" | "stopped" | "no_cell" = answer;

// A handle from `run`, a handle from `ready`, and a spread of either.
const handlers = { interpret: { wait: async () => {} } };
tell(line, run(line, handlers), ping("a"));
tell(line, await run(line, handlers).ready, ping("a"));
tell(line, fromRun, ping("a"));
tell(line, { ...fromRun }, ping("a"));
tell(line, { ...fromReady }, ping("a"));
const wrapped = { ...fromReady, label: "wrapped" };
tell(line, wrapped, ping("a"));

// @ts-expect-error `noopRuntime` has no line
tell(line, noopRuntime<LineState, LineMsg>(), ping("a"));

// @ts-expect-error a `Runtime` not known to come from `run` has no line
tell(line, booted, ping("a"));

// @ts-expect-error a `BootingRuntime` not known to come from `run` has no line
tell(line, booting, ping("a"));

const handBuilt: Runtime<LineState, LineMsg> = {
  ...noopRuntime<LineState, LineMsg>(),
};
// @ts-expect-error a `Runtime` built by hand has no line
tell(line, handBuilt, ping("a"));

// @ts-expect-error a spread of a `Runtime` built by hand has no line either
tell(line, { ...handBuilt }, ping("a"));

// @ts-expect-error a Msg outside the machine's union
tell(line, fromReady, { type: "unknown" });

// A fake typed as the host's `Runtime` stays valid as one, and a real handle
// still fits where a `Runtime` is asked for.
const fake: Runtime<LineState, LineMsg> = noopRuntime<LineState, LineMsg>();
const widened: Runtime<LineState, LineMsg> = fromReady;
const widenedBooting: BootingRuntime<LineState, LineMsg> = fromRun;

void [words, fake, widened, widenedBooting];
