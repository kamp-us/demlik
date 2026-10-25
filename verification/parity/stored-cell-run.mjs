import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

export const storedCellParity = (cargo, options) =>
  compiledTraceParity(cargo, "stored-cell", options);

await compiledTraceMain(import.meta.url, "stored-cell");
