/** biome-ignore-all lint/suspicious/noThenProperty: Source-only tests intentionally construct thenables to measure normalization/refusal. */
import assert from "node:assert/strict";
import {
  brainHandler,
  isPlainModel,
  PLAIN_MODEL_MISROUTE_REASON,
  plainModel,
} from "../../packages/tea/src/agent/model.ts";
import { createLlmCall } from "../../packages/tea/src/internal/llm-call/index.ts";

assert.equal(process.version, "v22.21.1");
const describe = (v) =>
  v === undefined
    ? { $value: "undefined" }
    : v instanceof Error
      ? { error: { name: v.name, message: v.message } }
      : typeof v === "number" && (!Number.isFinite(v) || Object.is(v, -0))
        ? { $value: Object.is(v, -0) ? "-0" : String(v) }
        : Array.isArray(v)
          ? v.map(describe)
          : v !== null && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, x]) => [k, describe(x)]),
              )
            : v;
const shape = (out) =>
  out._tag === "Ok"
    ? {
        kind: "ok",
        key: out.value.key,
        purpose: out.value.purpose,
        output: describe(out.value.output),
      }
    : {
        kind: "error",
        tag: out.error._tag,
        cause: describe(out.error.cause),
        ownCause: Object.hasOwn(out.error, "cause"),
      };
async function run(options) {
  const {
    name,
    kind = "factory",
    loader = "present",
    failure,
    transform = false,
    validateModel = false,
    distinctSchema = false,
  } = options;
  const cause = Object.hasOwn(options, "cause")
    ? options.cause
    : new Error("original\ud800");
  const trace = [],
    messages = [{ role: "user", opaque: { n: 1 } }],
    raw = { value: 0, opaque: { n: 1 } },
    input = { purpose: "turn", model: "id\ud800", payload: { same: true } },
    cmd = { type: "resilient_run", key: "k", input };
  let parses = 0,
    seenSchema = null,
    seenMessages = null,
    seenInput = null,
    lastParsed,
    firstParsed,
    reads = 0,
    release;
  const schema = (id) => ({
    parse(v) {
      trace.push(`parse:${id}`);
      parses++;
      if (failure === `parse${parses}`) throw cause;
      const result = transform ? { value: v.value + 1, opaque: v.opaque } : v;
      if (parses === 1) firstParsed = result;
      lastParsed = result;
      return result;
    },
  });
  const first = schema("first"),
    second = distinctSchema ? schema("second") : first;
  const schemas = Object.defineProperty({}, "turn", {
    get() {
      trace.push(`schema:${++reads}`);
      if (failure === "schema") throw cause;
      return reads === 1 ? first : second;
    },
  });
  const llm = createLlmCall({ schemas });
  const invoke = async (messagesArg) => {
    trace.push("invoke");
    seenMessages = messagesArg;
    if (failure === "invoke") throw cause;
    return validateModel ? seenSchema.parse(raw) : raw;
  };
  const factory = (id) => {
    trace.push("factory");
    assert.equal(id, input.model);
    if (failure === "factory") throw cause;
    return {
      withStructuredOutput(s) {
        trace.push("bind");
        seenSchema = s;
        if (failure === "bind") throw cause;
        return { invoke };
      },
    };
  };
  const plain = async (messagesArg) => {
    trace.push("plain");
    seenMessages = messagesArg;
    if (failure === "invoke") throw cause;
    return raw;
  };
  const sync = (messagesArg) => {
    trace.push("plain-sync-prefix");
    seenMessages = messagesArg;
    if (failure === "invoke") return Promise.reject(cause);
    return Promise.resolve(raw);
  };
  const model =
    kind === "plain" ? plain : kind === "wrapped" ? plainModel(sync) : factory;
  const ports = {
    model,
    ...(loader === "absent"
      ? {}
      : {
          loadMessages: async (call) => {
            trace.push("loader");
            seenInput = call;
            if (failure === "loader") throw cause;
            if (loader === "held")
              await new Promise((resolve) => {
                release = resolve;
              });
            return messages;
          },
        }),
  };
  const handler = brainHandler(llm, ports);
  const beforeHandle = [...trace];
  const pending = handler(cmd);
  const synchronousPrefix = [...trace];
  release?.();
  const out = await pending;
  const err =
    out._tag === "Err"
      ? llm.errOf({ type: "resilient_run_err", cmd, error: out.error, at: 1 })
      : null;
  return {
    name,
    beforeHandle,
    synchronousPrefix,
    trace,
    parses,
    schemaReads: reads,
    boundSame: kind === "factory" ? seenSchema === first : null,
    messagesSame: seenMessages === messages,
    defaultEmpty:
      loader === "absent"
        ? Array.isArray(seenMessages) && seenMessages.length === 0
        : null,
    inputSame: seenInput === input,
    rawSame: out._tag === "Ok" ? out.value.output === raw : null,
    lastParsedSame: out._tag === "Ok" ? out.value.output === lastParsed : null,
    firstParsedSame:
      out._tag === "Ok" ? out.value.output === firstParsed : null,
    causeSame: out._tag === "Err" ? out.error.cause === cause : null,
    errOfCauseSame: err ? err.error === cause : null,
    outcome: shape(out),
  };
}
const scenarios = [];
for (const value of [
  { name: "factory-loader-held", loader: "held" },
  { name: "factory-default-messages", loader: "absent" },
  { name: "factory-schema-transform", transform: true },
  {
    name: "factory-validates-transform-twice",
    transform: true,
    validateModel: true,
  },
  { name: "plain-transform-twice", kind: "plain", transform: true },
  { name: "wrapped-transform-twice", kind: "wrapped", transform: true },
  {
    name: "distinct-schemas",
    kind: "plain",
    transform: true,
    distinctSchema: true,
  },
  ...["factory", "loader", "schema", "bind", "invoke", "parse1"].map(
    (failure) => ({ name: `factory-${failure}-error`, failure }),
  ),
  { name: "plain-first-parse-error", kind: "plain", failure: "parse1" },
  { name: "plain-second-parse-error", kind: "plain", failure: "parse2" },
  ...[
    undefined,
    null,
    "raw cause",
    17,
    { reason: "payload", raw: "\ud800" },
  ].map((cause, index) => ({
    name: `original-raw-cause-${index}`,
    failure: "invoke",
    cause,
  })),
])
  scenarios.push(await run(value));
const manual = [];
const llm = createLlmCall({ schemas: { turn: { parse: (v) => v } } }),
  cmd = {
    type: "resilient_run",
    key: "k",
    input: { purpose: "turn", model: null, payload: null },
  };
for (const [name, model] of [
  ["missing", undefined],
  ["null", null],
  ["number", 1],
  ["bare-sync-promise", () => Promise.resolve({})],
  ["bare-sync-rejection", () => Promise.reject(new Error("drained"))],
  [
    "object-thenable",
    () => ({
      then(ok, bad) {
        assert.equal(ok, undefined);
        assert.equal(typeof bad, "function");
        bad(new Error("drained thenable"));
      },
    }),
  ],
  [
    "function-with-then",
    () =>
      Object.assign(() => {}, {
        then() {},
        withStructuredOutput() {
          return { invoke: async () => ({ value: 1 }) };
        },
      }),
  ],
  [
    "object-non-callable-then",
    () => ({
      then: 1,
      withStructuredOutput() {
        return { invoke: async () => ({ value: 2 }) };
      },
    }),
  ],
]) {
  const handler = brainHandler(llm, { model });
  const out = await handler(cmd);
  manual.push({
    name,
    outcome: shape(out),
    misroute:
      out._tag === "Err" &&
      out.error.cause?.message === PLAIN_MODEL_MISROUTE_REASON,
  });
}
const thrown = new Error("then getter original");
for (const [name, model] of [
  [
    "then-getter-throw",
    () =>
      Object.defineProperty({}, "then", {
        get() {
          throw thrown;
        },
      }),
  ],
  [
    "then-call-throw",
    () => ({
      then() {
        throw thrown;
      },
    }),
  ],
]) {
  const out = await brainHandler(llm, { model })(cmd);
  manual.push({
    name,
    outcome: shape(out),
    causeSame: out._tag === "Err" && out.error.cause === thrown,
  });
}
let constructionCauseSame = false;
const poisoned = () => {};
Object.defineProperty(poisoned, Symbol.toStringTag, {
  get() {
    throw thrown;
  },
});
try {
  brainHandler(llm, { model: poisoned });
} catch (error) {
  constructionCauseSame = error === thrown;
}
const spoofed = () => {};
Object.defineProperty(spoofed, Symbol.toStringTag, { value: "AsyncFunction" });
const introspection = {
  async: isPlainModel(async () => {}),
  asyncTwoArguments: isPlainModel(async (_m, _unused) => {}),
  boundAsync: isPlainModel((async () => {}).bind(null)),
  syncPromise: isPlainModel(() => Promise.resolve({})),
  wrapped: isPlainModel(plainModel(() => Promise.resolve({}))),
  spoofed: isPlainModel(spoofed),
  asyncGenerator: isPlainModel(async function* () {}),
  constructionCauseSame,
};
const emptyBatches = [];
const emptyHandle = brainHandler(llm, {
  model: () => ({
    withStructuredOutput() {
      return {
        invoke: async (messages) => {
          emptyBatches.push(messages);
          return {};
        },
      };
    },
  }),
});
await emptyHandle(cmd);
await emptyHandle(cmd);
const defaultEmptyFresh =
  emptyBatches.length === 2 &&
  emptyBatches[0] !== emptyBatches[1] &&
  emptyBatches.every((x) => x.length === 0);
console.log(
  JSON.stringify(
    {
      sourceOnly: true,
      strictNativeParity: false,
      nativeQualification:
        "Explicit native port kinds and declared Result failures. JS function tags/arity/thenables/getters/prototypes and eager Promise prefixes remain Source-only; no native parity evidence is produced here.",
      defaultEmptyFresh,
      node: process.version,
      v8: process.versions.v8,
      scenarios,
      manualSourceOnly: manual,
      introspectionSourceOnly: introspection,
      misrouteReason: PLAIN_MODEL_MISROUTE_REASON,
    },
    null,
    2,
  ),
);
