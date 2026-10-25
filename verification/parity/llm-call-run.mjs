import { compiledTraceMain, compiledTraceParity } from "./compiled-traces.mjs";

export const llmCallParity = (cargo, options) =>
  compiledTraceParity(cargo, "llm-call", { ...options, format: "llm" });

await compiledTraceMain(import.meta.url, "llm-call", { format: "llm" });
