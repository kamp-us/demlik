import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

export const timestampParity = (cargo, options) =>
  compiledTraceParity(cargo, "timestamps", {
    ...options,
    format: "timestamps",
  });

await compiledTraceMain(import.meta.url, "timestamps", {
  format: "timestamps",
});
