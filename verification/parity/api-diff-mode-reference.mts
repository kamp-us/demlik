import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  runApiFlags,
  runApiView,
} from "../../packages/code-graph/src/api/cli.ts";
import { diffPublishedApi } from "../../packages/code-graph/src/api/diff.ts";
import { ApiInputError } from "../../packages/code-graph/src/api/map.ts";

const failure = z
  .object({
    kind: z.enum(["input", "callback", "cleanup-input"]),
    message: z.string(),
  })
  .strict();
const baseMap = z
  .object({
    kind: z.enum(["value", "file", "fail"]),
    file: z.string().optional(),
    value: z.unknown().optional(),
    failure: failure.nullable().optional(),
    awaited: z.boolean().default(false),
    readonly: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "file" && value.file === undefined)
      ctx.addIssue({ code: "custom", message: "file map needs file" });
    if (value.kind === "fail" && !value.failure)
      ctx.addIssue({ code: "custom", message: "failed map needs failure" });
    if (value.kind === "value" && !Object.hasOwn(value, "value"))
      ctx.addIssue({ code: "custom", message: "value map needs value" });
  });
const diff = z
  .object({
    root: z.string(),
    map: z.unknown(),
    base: z.string(),
    repoRoot: z.string().optional(),
    baseMap: baseMap.nullable().optional(),
    warnFailure: failure.nullable().optional(),
  })
  .strict()
  .refine((value) => Object.hasOwn(value, "map"), "map required");
const mode = z
  .object({
    root: z.string(),
    mapFile: z.string().optional(),
    base: z.string().optional(),
    policyFile: z.string().optional(),
    given: z.array(z.string()),
    json: z.boolean(),
    pretty: z.boolean(),
    entry: z.enum(["flags", "view"]),
    emitFailure: failure.nullable().optional(),
    reportFailure: failure.nullable().optional(),
    outFile: z.string().optional(),
  })
  .strict()
  .refine(
    (value) => value.entry !== "view" || value.mapFile !== undefined,
    "view needs mapFile",
  );
const request = z.discriminatedUnion("operation", [
  z
    .object({ id: z.string(), operation: z.literal("diff"), input: diff })
    .strict(),
  z
    .object({ id: z.string(), operation: z.literal("mode"), input: mode })
    .strict(),
]);
type Failure = z.infer<typeof failure>;
function throwFailure(value: Failure): never {
  if (value.kind === "input" || value.kind === "cleanup-input")
    throw new ApiInputError(value.message);
  throw new Error(value.message);
}
function errorView(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}
async function runDiff(input: z.infer<typeof diff>) {
  const warnings: string[] = [],
    roots: string[] = [];
  const selectedMap = input.baseMap;
  const options = {
    repoRoot: input.repoRoot,
    warn: (message: string) => {
      warnings.push(message);
      if (input.warnFailure) throwFailure(input.warnFailure);
    },
    ...(selectedMap
      ? {
          baseMap: selectedMap.awaited
            ? async (root: string) => {
                roots.push(root);
                await new Promise<void>((resolve) => queueMicrotask(resolve));
                return load(root, selectedMap);
              }
            : (root: string) => {
                roots.push(root);
                return load(root, selectedMap);
              },
        }
      : {}),
  };
  function load(root: string, spec: z.infer<typeof baseMap>): unknown {
    if (spec.readonly) fs.chmodSync(root, 0o555);
    if (spec.kind === "value") return spec.value;
    if (spec.kind === "fail") {
      assert.ok(spec.failure);
      throwFailure(spec.failure);
    }
    assert.ok(spec.file !== undefined);
    return JSON.parse(fs.readFileSync(path.join(root, spec.file), "utf8"));
  }
  let value: Awaited<ReturnType<typeof diffPublishedApi>> | undefined,
    error: ReturnType<typeof errorView> | undefined;
  try {
    value = await diffPublishedApi(input.root, input.map, input.base, options);
  } catch (cause) {
    error = errorView(cause);
  }
  return {
    ...(value ? { value } : {}),
    ...(error ? { error } : {}),
    warnings,
    baseMap: {
      calls: roots.length,
      outsideCheckout: roots.map((root) => !root.startsWith(`${input.root}/`)),
      existsAfter: roots.map((root) => fs.existsSync(root)),
    },
  };
}
async function runMode(input: z.infer<typeof mode>) {
  const events: { kind: string; message: string }[] = [];
  const host = {
    rootAbsolute: input.root,
    given: input.given,
    json: input.json,
    pretty: input.pretty,
    emit: (message: string) => {
      events.push({ kind: "emit", message });
      if (input.emitFailure) throwFailure(input.emitFailure);
      if (input.outFile !== undefined) fs.writeFileSync(input.outFile, message);
    },
    report: (message: string) => {
      events.push({ kind: "report", message });
      if (input.reportFailure) throwFailure(input.reportFailure);
    },
  };
  try {
    const result =
      input.entry === "flags"
        ? runApiFlags(
            {
              api: input.mapFile,
              apiBase: input.base,
              apiPolicy: input.policyFile,
            },
            host,
          )
        : (() => {
            assert.ok(input.mapFile !== undefined);
            return runApiView({
              ...host,
              mapFile: input.mapFile,
              base: input.base,
              policyFile: input.policyFile,
            });
          })();
    return { code: result === null ? null : await result, events };
  } catch (error) {
    return { code: null, error: errorView(error), events };
  }
}
for await (const line of createInterface({ input: process.stdin })) {
  let id: string | null = null;
  try {
    const raw: unknown = JSON.parse(line);
    if (
      typeof raw === "object" &&
      raw !== null &&
      "id" in raw &&
      typeof raw.id === "string"
    )
      id = raw.id;
    const value = request.parse(raw);
    process.stderr.write(`API_CASE ${JSON.stringify(id)}\n`);
    const output =
      value.operation === "diff"
        ? await runDiff(value.input)
        : await runMode(value.input);
    console.log(JSON.stringify({ id, ok: true, output }));
  } catch (error) {
    console.log(JSON.stringify({ id, ok: false, error: String(error) }));
  }
}
