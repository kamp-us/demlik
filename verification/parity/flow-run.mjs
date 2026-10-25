import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";
export function flowParity(cargo, options = {}) {
  return compiledTraceParity(cargo, "flow", options);
}
await compiledTraceMain(import.meta.url, "flow");
