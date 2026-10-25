import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

export const durableObjectParity = (cargo, options) =>
  compiledTraceParity(cargo, "durable-object", options);

await compiledTraceMain(import.meta.url, "durable-object");
