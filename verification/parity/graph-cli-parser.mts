import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineProgram } from "../../packages/code-graph/src/cli.js";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled CLI parser driver");
assert.ok(process.argv.length <= 4);
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const repository = fileURLToPath(new URL("../..", import.meta.url));
const owner = createRequire(
  path.join(repository, "packages/code-graph/package.json"),
);
const commander = path.join(
  path.dirname(owner.resolve("commander")),
  "package.json",
);
assert.equal(JSON.parse(fs.readFileSync(commander, "utf8")).version, "11.1.0");
const width = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullable()
  .optional();
const schema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("parse"),
    argv: z.array(z.string()),
    helpWidth: width,
  }),
  z.strictObject({ action: z.literal("help"), width }),
  z.strictObject({ action: z.literal("metadata") }),
]);
type Input = z.infer<typeof schema>;
type Case = { id: string; operation: "code_graph.cli-parser"; input: Input };
const cases: Case[] = [];
const add = (id: string, input: unknown) =>
  cases.push({
    id,
    operation: "code_graph.cli-parser",
    input: schema.parse(input),
  });
const parse = (id: string, argv: string[], helpWidth?: number | null) =>
  add(id, { action: "parse", argv, helpWidth });
const options = defineProgram().options;
assert.equal(options.length, 52);
assert.deepEqual(
  options.filter((option) => option.short).map((option) => option.short),
  [],
);
assert.equal(defineProgram().registeredArguments.length, 1);
add("metadata.52-options-one-target", { action: "metadata" });
const termWidth = Math.max(...options.map((option) => option.flags.length));
for (const columns of [
  undefined,
  null,
  0,
  1,
  20,
  40,
  60,
  80,
  100,
  120,
  200,
  termWidth + 43,
  termWidth + 44,
  termWidth + 45,
  1_000_000_000,
]) {
  add(`help.width-${columns ?? String(columns)}`, {
    action: "help",
    width: columns,
  });
}
const fixed: string[][] = [
  [],
  ["src"],
  [""],
  ["src", "extra", "third"],
  ["-"],
  ["-1"],
  ["--"],
  ["--", ""],
  ["--", "--help"],
  ["path", "--", "--json"],
  ["--unknown", "src", "--json"],
  ["src", "--unknown", "val", "--file", "x"],
  ["--unknown", "--", "--help"],
  ["--help"],
  ["-h"],
  ["--unknown", "--help"],
  ["--help", "--by"],
  ["--by", "--help"],
  ["src", "--by", "--help"],
  ["-hx"],
  ["-hh"],
  ["--help=x"],
  ["--help="],
  ["--Help"],
  ["--json=false", "src"],
  ["--no-json", "src"],
  ["--by", "--json"],
  ["--by", "--", "src"],
  ["--hotspots-limit", "20", "--by", "rot", "--json", "src"],
  ["--json", "--by", "rot", "src"],
  ["--entry-preset", "nextjs", "--entry-preset=unknown", "src"],
  ["--entry-preset=", "src"],
  ["src", "--unknown", "--json", "--help"],
  ["--bad", "--out"],
  ["--out", "--help", "src"],
  ["--=value"],
  ["---json"],
  ["--json\u0000"],
  ["--JSON"],
  ["--pretty", "--pretty", "src"],
  ["--by=first", "--by", "rot", "src"],
  ["--entry-preset=first", "--entry-preset=first", "src"],
];
for (const [index, argv] of fixed.entries())
  parse(`parse.fixed-${index}`, argv);
parse("handoff.api-explicit-default-refusal-order", [
  "--api",
  "api.json",
  "--hotspots-limit",
  "20",
  "--by",
  "rot",
  "--json",
  "src",
]);
parse("handoff.api-companions", [
  "--api=api.json",
  "--api-base=HEAD",
  "--api-policy=policy.json",
  "--json",
  "--pretty",
  "--out=report.json",
  "src",
]);
parse("handoff.api-empty-map-is-present", ["--api=", "src"]);
const all: string[] = [];
for (const option of options) {
  const flag = option.long;
  assert.ok(flag);
  const key = option.attributeName();
  if (option.required) {
    parse(`option.${key}.space`, [flag, `raw:${key}`, "src"]);
    parse(`option.${key}.equal`, ["src", `${flag}=value=two`]);
    parse(`option.${key}.empty`, [`${flag}=`, "src"]);
    parse(`option.${key}.missing`, ["src", flag]);
    parse(`option.${key}.consumes-help`, [flag, "--help", "src"]);
    parse(`option.${key}.consumes-delimiter`, [flag, "--", "src"]);
    parse(`option.${key}.repeat`, [flag, "first", `${flag}=second`, "src"]);
    for (const [index, value] of [
      "raw\ud800",
      "raw\udfff",
      "nul\u0000end",
      "pair😀",
      "line\n\t\u0085\u2028next",
      "  spaces  ",
      "__proto__",
    ].entries()) {
      parse(`option.${key}.raw-${index}`, ["src", flag, value]);
    }
    all.push(flag, `${key}:all`);
  } else {
    parse(`option.${key}.before`, [flag, "src"]);
    parse(`option.${key}.after`, ["src", flag]);
    parse(`option.${key}.equal-is-unknown`, [`${flag}=false`, "src"]);
    parse(`option.${key}.negated-is-unknown`, [`--no-${flag.slice(2)}`, "src"]);
    all.push(flag);
  }
  const name = flag.slice(2);
  const transposed = name.length > 2 ? name[1] + name[0] + name.slice(2) : name;
  parse(`suggest.${key}.deleted`, [`--${name.slice(0, -1)}`, "src"]);
  parse(`suggest.${key}.transposed`, [`--${transposed}`, "src"]);
}
parse("parse.all-options", ["src", ...all]);
for (const [index, flag] of [
  "--j",
  "--h",
  "--he",
  "--it",
  "--pritty",
  "--headrs",
  "--api-b",
  "--a",
  "--r",
  "--clas",
  "-json",
  "--\ud800",
  "--pre\ud800ty",
  "--😀",
  `--${"x".repeat(10000)}`,
].entries()) {
  parse(`suggest.special-${index}`, [flag, "src"]);
}
parse("isolation.presets-first", ["--entry-preset=first", "src"]);
parse("isolation.fresh-defaults", ["src"]);
parse("isolation.explicit-defaults", [
  "--by=rot",
  "--fail-on=high",
  "--hotspots-days=90",
  "--hotspots-limit=20",
  "src",
]);
parse("isolation.fresh-sources", ["src"]);
for (const [index, target] of [
  "../packages/real project",
  "raw\ud800/path",
  "raw\udfff",
  "pair😀/漢字",
  "nul\u0000target",
  "line\n\t\u0085\u2028next",
].entries())
  parse(`target.raw-${index}`, [target, "--json"]);

function reference(input: Input): unknown {
  if (input.action === "metadata")
    return defineProgram().options.map((option) => ({
      flags: option.flags,
      key: option.attributeName(),
      description: option.description,
      required: option.required,
      optional: option.optional,
      variadic: option.variadic,
      short: option.short ?? null,
      long: option.long,
      defaultValue: option.defaultValue ?? null,
    }));
  const p = defineProgram();
  const helpWidth = input.action === "help" ? input.width : input.helpWidth;
  p.configureOutput({
    getOutHelpWidth: () => helpWidth ?? 80,
    getErrHelpWidth: () => helpWidth ?? 80,
  });
  if (input.action === "help") return p.helpInformation();
  let stdout = "",
    stderr = "";
  let exit: {
    name: string;
    code: string;
    exitCode: number;
    message: string;
  } | null = null;
  p.exitOverride().configureOutput({
    writeOut: (text) => {
      stdout += text;
    },
    writeErr: (text) => {
      stderr += text;
    },
  });
  try {
    p.parse(input.argv, { from: "user" });
  } catch (error) {
    assert.ok(error instanceof Error && "code" in error && "exitCode" in error);
    exit = {
      name: error.name,
      code: String(error.code),
      exitCode: Number(error.exitCode),
      message: error.message,
    };
  }
  const opts = p.opts();
  return {
    status: exit?.exitCode ?? 0,
    exit,
    stdout,
    stderr,
    args: p.args,
    processedArgs: p.processedArgs,
    opts,
    keys: Object.keys(opts),
    given: Object.keys(opts).filter(
      (key) => p.getOptionValueSource(key) === "cli",
    ),
    sources: p.options.map((option) => [
      option.attributeName(),
      p.getOptionValueSource(option.attributeName()) ?? null,
    ]),
    target: exit === null ? p.processedArgs[0] : null,
  };
}
const expected = cases.map((item) => reference(item.input));
const invalid = [
  {
    id: "invalid.operation",
    operation: "other",
    input: { action: "parse", argv: [] },
  },
  {
    id: "invalid.action",
    operation: "code_graph.cli-parser",
    input: { action: "unknown" },
  },
  {
    id: "invalid.argv-type",
    operation: "code_graph.cli-parser",
    input: { action: "parse", argv: "src" },
  },
  {
    id: "invalid.argv-element",
    operation: "code_graph.cli-parser",
    input: { action: "parse", argv: [null] },
  },
  {
    id: "invalid.unknown-field",
    operation: "code_graph.cli-parser",
    input: { action: "parse", argv: ["src"], ignored: true },
  },
  {
    id: "invalid.width-negative",
    operation: "code_graph.cli-parser",
    input: { action: "help", width: -1 },
  },
  {
    id: "invalid.width-fraction",
    operation: "code_graph.cli-parser",
    input: { action: "help", width: 80.5 },
  },
  {
    id: "invalid.width-type",
    operation: "code_graph.cli-parser",
    input: { action: "help", width: "80" },
  },
  {
    id: "invalid.root-field",
    operation: "code_graph.cli-parser",
    input: { action: "metadata" },
    ignored: true,
  },
];
const requests = [...cases, ...invalid];
const run = spawnSync(binary, [], {
  input: `${requests.map((item) => JSON.stringify(item)).join("\n")}\n`,
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
});
assert.equal(run.status, 0, run.stderr);
assert.equal(run.stderr, "");
const reply = z.strictObject({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.strictObject({ tag: z.string(), message: z.string() }).optional(),
  observedCalls: z.array(z.string()),
});
const answers = run.stdout
  .trimEnd()
  .split("\n")
  .map((line) => reply.parse(JSON.parse(line)));
assert.equal(answers.length, requests.length);
const failures: {
  id: string;
  message: string;
  expected: unknown;
  actual: unknown;
}[] = [];
for (const [index, item] of cases.entries()) {
  const answer = answers[index];
  try {
    assert.equal(answer.id, item.id);
    assert.equal(answer.ok, true, JSON.stringify(answer.error));
    assert.deepEqual(answer.output, expected[index]);
    assert.ok(answer.observedCalls.length > 0);
  } catch (error) {
    failures.push({
      id: item.id,
      message: String(error),
      expected: expected[index],
      actual: answer,
    });
  }
}
for (const [index] of invalid.entries()) {
  const answer = answers[cases.length + index];
  assert.equal(answer.ok, false);
  assert.equal(answer.error?.tag, "driver-error");
  assert.deepEqual(answer.observedCalls, []);
}
const sourceFiles = [
  "packages/code-graph/src/cli.ts",
  ...["command.js", "help.js", "suggestSimilar.js", "option.js"].map((file) =>
    path.join(path.dirname(commander), "lib", file),
  ),
];
const report = {
  passed: cases.length - failures.length,
  attempted: cases.length,
  rejectedInvalidInputs: invalid.length,
  reference: {
    node: process.version,
    v8: process.versions.v8,
    commander: "11.1.0",
    source:
      "frozen defineProgram via actual Commander exitOverride/configureOutput",
    sourceHashes: Object.fromEntries(
      sourceFiles.map((file) => [
        file,
        createHash("sha256")
          .update(fs.readFileSync(path.resolve(repository, file)))
          .digest("hex"),
      ]),
    ),
    native:
      "actual demlik_code_graph::cli::parse/help_information and owned OPTION_SPECS; typed value/source/target facts; no graph execution",
  },
  inventory: {
    declaredOptions: 52,
    requiredArguments: 1,
    implicitHelpOptions: 1,
  },
  failures,
  cases: requests.map((item, index) => ({
    ...item,
    expected: index < cases.length ? expected[index] : { rejected: true },
    ...answers[index],
  })),
};
if (process.argv[3])
  fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ passed: report.passed, attempted: report.attempted, rejectedInvalidInputs: invalid.length, failures: failures.map((row) => row.id) })}\n`,
);
assert.deepEqual(
  failures.map((row) => row.id),
  [],
);
