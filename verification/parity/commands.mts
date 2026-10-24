import { z } from "zod";
import {
  Cmd,
  cmdContractOver,
  followUps,
  Outcome,
  subIdOf,
  validateSync,
} from "../../packages/tea/src/pure/core.ts";

export const commandDependencyInput = z.object({ json: z.string() });
export function executeCommandDependency(
  input: z.infer<typeof commandDependencyInput>,
) {
  const schema = z.record(z.string(), z.unknown());
  const definition = Cmd.define("floating", {
    input: schema,
    ok: z.undefined(),
    err: [],
  });
  const command = definition(schema.parse(JSON.parse(input.json)));
  return { id: subIdOf("watch", command), json: JSON.stringify(command) };
}

type Schema<T = unknown> = Parameters<typeof validateSync<T>>[0];

const outputSchema = z.enum(["identity", "body", "trim", "nested", "async"]);
type OutputSchema = z.infer<typeof outputSchema>;
function schema(kind: OutputSchema): Schema {
  return {
    "~standard": {
      version: 1,
      vendor: "parity",
      validate(value) {
        if (kind === "async") return Promise.resolve({ value });
        if (kind === "identity") return { value };
        if (kind === "trim")
          return typeof value === "string"
            ? { value: value.trim() }
            : { issues: [{ message: "Expected a string" }] };
        if (kind === "nested")
          return {
            issues: [
              {
                path: [{ key: "payload" }, 0, { key: "body" }],
                message: "Expected nested body string",
              },
              { message: "Expected complete result" },
            ],
          };
        if (
          value !== null &&
          typeof value === "object" &&
          "body" in value &&
          typeof value.body === "string"
        )
          return { value: { body: value.body } };
        return {
          issues: [{ path: ["body"], message: "Expected body string" }],
        };
      },
    },
  };
}

const inputSchema: Schema<{ url: string }> = {
  "~standard": {
    version: 1,
    vendor: "parity",
    validate(value) {
      if (
        value !== null &&
        typeof value === "object" &&
        "url" in value &&
        typeof value.url === "string"
      )
        return { value: { url: value.url.trim() } };
      return {
        issues: [{ path: ["url"], message: "Expected url string" }],
      };
    },
  },
};

const definition = z.object({
  name: z.string(),
  schema: outputSchema,
  errorTags: z.array(z.string()),
});
const dispatch = z.object({
  source: z.enum(["minted", "copy", "foreign", "message"]),
  message: z.unknown().optional(),
});
export const commandContractInput = z.object({
  definitions: z.array(definition),
  cmd: z.object({ type: z.string() }).passthrough(),
  returned: z.unknown().optional(),
  at: z.number(),
  dispatch: z.array(dispatch).default([]),
});

function errorData(error: unknown) {
  if (!(error instanceof Error)) throw error;
  return {
    name: error.name,
    message: error.message,
    ...Object.fromEntries(Object.entries(error)),
  };
}

export function executeCommandContract(
  input: z.infer<typeof commandContractInput>,
) {
  const definitions = input.definitions.map((item) =>
    Cmd.define(item.name, {
      input: inputSchema,
      ok: schema(item.schema),
      err: item.errorTags,
    }),
  );
  let clockCalls = 0;
  const clock = () => {
    clockCalls++;
    return input.at;
  };
  const contract = cmdContractOver(definitions, clock);
  try {
    const settled = contract.settle(input.cmd, input.returned);
    const dispatchResults = input.dispatch.map((item) => {
      const candidate =
        item.source === "minted"
          ? settled
          : item.source === "copy"
            ? JSON.parse(JSON.stringify(settled))
            : item.source === "foreign"
              ? cmdContractOver(definitions, clock).settle(
                  input.cmd,
                  input.returned,
                )
              : item.message;
      try {
        contract.checkDispatch(input.cmd, candidate as { type: string });
        return { accepted: true };
      } catch (error) {
        return { accepted: false, error: errorData(error) };
      }
    });
    return {
      settled: settled ?? null,
      followUps: followUps(settled),
      clockCalls,
      dispatchResults,
    };
  } catch (error) {
    return { error: errorData(error), clockCalls };
  }
}

export const commandBuilderInput = z.object({
  input: z.object({ url: z.string() }).passthrough(),
  value: z.unknown(),
  error: z.object({ _tag: z.enum(["timeout", "not_found"]) }).passthrough(),
  at: z.number().optional(),
});
export function executeCommandBuilders(
  input: z.infer<typeof commandBuilderInput>,
) {
  const fetch = Cmd.define("fetch", {
    input: inputSchema,
    ok: schema("body"),
    err: ["timeout", "not_found"],
  });
  const cmd = fetch(input.input);
  return {
    cmd,
    roundTrip: JSON.parse(JSON.stringify(cmd)),
    ok: fetch.ok(cmd, input.value, input.at),
    err: fetch.err(cmd, input.error, input.at),
    declaration: {
      cmdType: fetch.cmdType,
      okType: fetch.okType,
      errType: fetch.errType,
      errorTags: fetch.errTags,
    },
  };
}

export const commandParseInput = z.object({ value: z.unknown() });
export function executeCommandInput(input: z.infer<typeof commandParseInput>) {
  const parsed = validateSync(inputSchema, input.value, "command input");
  if (parsed.issues)
    return {
      issues: parsed.issues.map((issue) => ({
        path: (issue.path ?? []).join("."),
        message: issue.message,
      })),
    };
  const def = Cmd.define("fetch", {
    input: inputSchema,
    ok: schema("body"),
    err: ["timeout", "not_found"],
  });
  return { cmd: def(parsed.value) };
}

export const commandHelpersInput = z.object({
  groups: z.array(z.array(z.object({ type: z.string() }).passthrough())),
  condition: z.boolean(),
  value: z.unknown().optional(),
  ok: z.unknown(),
  error: z.unknown(),
});
export function executeCommandHelpers(
  input: z.infer<typeof commandHelpersInput>,
) {
  let buildCalls = 0;
  const whenDefined = Cmd.whenDefined(input.value, (value) => {
    buildCalls++;
    return { type: "picked", value };
  });
  return {
    none: Cmd.none,
    batch: Cmd.batch(...input.groups),
    when: Cmd.when(input.condition, { type: "conditional" }),
    whenDefined,
    buildCalls,
    ok: Outcome.ok(input.ok),
    err: Outcome.err(input.error),
  };
}
