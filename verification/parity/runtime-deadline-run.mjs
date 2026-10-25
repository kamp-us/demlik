import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";
export function runtimeDeadlineParity(cargo, options = {}) {
  return compiledTraceParity(cargo, "runtime-deadline", options);
}
await compiledTraceMain(import.meta.url, "runtime-deadline");
