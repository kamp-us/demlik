import {
  breadcrumbsFromTrace,
  recorder,
  type Trace,
} from "../../packages/tea/src/internal/persistence/recorder/index.ts";
import type { BootingRuntime } from "../../packages/tea/src/runtime-types.ts";

type State = { type: "counting"; count: number };
type Msg = { type: "add"; by: number };

export function sourceRecorderTypes(runtime: BootingRuntime<State, Msg>) {
  const trace = recorder(runtime, { captureSteps: true }).dump();
  const positive: Trace<State, Msg> = trace;
  breadcrumbsFromTrace(positive, { serialize: (msg) => `add ${msg.by}` });
  // @ts-expect-error A recorder's captured message family remains precise.
  const wrong: Trace<State, { type: "reset" }> = trace;
  // @ts-expect-error Breadcrumb renderers return text, not a numeric payload.
  breadcrumbsFromTrace(trace, { serialize: (msg) => msg.by });
  return { positive, wrong };
}
