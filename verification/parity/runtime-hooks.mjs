import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";
export function runtimeHooksParity(cargo, options = {}) {
  return compiledTraceParity(cargo, "runtime-hooks", options);
}
await compiledTraceMain(import.meta.url, "runtime-hooks");
