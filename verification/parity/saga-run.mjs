import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";
export function sagaParity(cargo, options = {}) {
  return compiledTraceParity(cargo, "saga", options);
}
await compiledTraceMain(import.meta.url, "saga");
