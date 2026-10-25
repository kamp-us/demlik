import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";
export function monitoredRunParity(cargo, options = {}) {
  return compiledTraceParity(cargo, "monitored-run", options);
}
await compiledTraceMain(import.meta.url, "monitored-run");
