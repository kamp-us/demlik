import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

export const intakeRuntimeParity = (cargo, options) =>
  compiledTraceParity(cargo, "intake-runtime", { ...options, format: "llm" });

await compiledTraceMain(import.meta.url, "intake-runtime", { format: "llm" });
