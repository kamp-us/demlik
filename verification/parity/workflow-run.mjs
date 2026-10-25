import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";
export function workflowParity(cargo, options = {}) {
  return compiledTraceParity(cargo, "workflow", options);
}
await compiledTraceMain(import.meta.url, "workflow");
