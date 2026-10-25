import { brainHandler } from "../../packages/tea/src/agent/model.ts";
import { createLlmCall } from "../../packages/tea/src/internal/llm-call/index.ts";

const results = [];
for (const variant of ["missing", "undefined", "null"]) {
  const trace = [],
    llm = createLlmCall({ schemas: { turn: { parse: (v) => v } } });
  const cmd = {
    type: "resilient_run",
    key: "turn",
    ...(variant === "missing"
      ? {}
      : { input: variant === "null" ? null : undefined }),
  };
  const out = await brainHandler(llm, {
    model: () => {
      trace.push("factory");
      return {
        withStructuredOutput() {
          trace.push("bind");
          return { invoke: async () => ({}) };
        },
      };
    },
  })(cmd);
  results.push({
    variant,
    trace,
    returned: out._tag,
    tag: out.error?._tag,
    cause: { name: out.error?.cause?.name, message: out.error?.cause?.message },
  });
}
for (const at of [1, 2]) {
  const cause = new Error("original schema lookup"),
    trace = [];
  let reads = 0;
  const schemas = Object.defineProperty({}, "turn", {
    get() {
      trace.push(`schema:${++reads}`);
      if (reads === at) throw cause;
      return { parse: (v) => v };
    },
  });
  const llm = createLlmCall({ schemas });
  const cmd = {
    type: "resilient_run",
    key: "turn",
    input: { purpose: "turn", model: null, payload: null },
  };
  const out = await brainHandler(llm, {
    model: () => ({
      withStructuredOutput() {
        trace.push("bind");
        return {
          invoke: async () => {
            trace.push("invoke");
            return {};
          },
        };
      },
    }),
  })(cmd);
  results.push({
    variant: `schema-callback-${at}`,
    trace,
    returned: out._tag,
    tag: out.error?._tag,
    causeSame: out.error?.cause === cause,
  });
}
const cause = new Error("decode throw original"),
  base = createLlmCall({ schemas: { turn: { parse: (v) => v } } }),
  custom = {
    ...base,
    decode() {
      throw cause;
    },
  };
const out = await brainHandler(custom, {
  model: () => ({
    withStructuredOutput() {
      return { invoke: async () => ({}) };
    },
  }),
})({
  type: "resilient_run",
  key: "turn",
  input: { purpose: "turn", model: null, payload: null },
});
results.push({
  variant: "replaced-decode-throws",
  returned: out._tag,
  tag: out.error?._tag,
  causeSame: out.error?.cause === cause,
});
console.log(
  JSON.stringify(
    {
      node: process.version,
      v8: process.versions.v8,
      sourceOnlyBoundaryQualification: true,
      results,
    },
    null,
    2,
  ),
);
