import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";
export function pollerParity(cargo, options = {}) {
  return compiledTraceParity(cargo, "poller", options);
}
await compiledTraceMain(import.meta.url, "poller");
