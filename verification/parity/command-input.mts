import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  intakeProcessDef,
  intakeReplayDef,
} from "../../packages/tea/src/idempotency/index.js";
import { Cmd, Outcome } from "../../packages/tea/src/index.js";
import { snapshotWriteDef } from "../../packages/tea/src/persistence/index.js";
import {
  type CmdInput,
  cmdContractOver,
  validateSync,
} from "../../packages/tea/src/pure/core.js";
import { decode, normalize } from "./timing-clock.mts";

const script = z
  .object({
    family: z.enum(["process", "replay", "snapshot"]),
    fields: z.unknown(),
    roundTrip: z.boolean().optional(),
    mutate: z.unknown().optional(),
    failDecoder: z.boolean().optional(),
    name: z.string().optional(),
  })
  .strict();
type Script = z.infer<typeof script>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasTag = (
  value: unknown,
): value is Record<string, unknown> & { type: string } =>
  isRecord(value) && typeof value.type === "string";
const u = { $undefined: true };
function record(entries: [unknown, unknown][]): unknown {
  return { $object: entries };
}
export function commandInputCases() {
  const cases: { id: string; input: Script }[] = [];
  for (const family of ["process", "replay", "snapshot"] as const) {
    const known = family === "replay" ? "result" : "payload";
    const base: [unknown, unknown][] = [["key", "input"]];
    if (family === "process") base.push(["itemId", "job"]);
    if (family === "snapshot") base.push(["seq", 2], ["at", 17.25]);
    const inputs: [string, [unknown, unknown][], Partial<Script>?][] = [
      ["object", [...base, [known, { n: 1 }]]],
      ["null", [...base, [known, null]]],
      ["undefined", [...base, [known, u]]],
      ["missing", base],
      ["array", [...base, [known, [1, null, u]]]],
      [
        "unknown-own-proto",
        [
          ["extra", { keep: true }],
          ["__proto__", { owned: 1 }],
          ...base,
          [known, { n: 1 }],
          ["otherUndefined", u],
          [{ $utf16: [0xd800] }, "unit"],
          ["10", "ten"],
          ["2", "two"],
        ],
      ],
      [
        "mutable-reference",
        [...base, [known, { n: 1 }]],
        { mutate: { after: "decode" } },
      ],
      ["named", [...base, [known, { n: 1 }]], { name: `named-${family}` }],
      ["caller-error", [...base, [known, { n: 1 }]], { failDecoder: true }],
      [
        "text",
        base
          .map<[unknown, unknown]>(([k, v]) => [
            k,
            k === "key" ? { $utf16: [0xd800, 65] } : v,
          ])
          .concat([[known, { $utf16: [0xdfff] }]]),
      ],
    ];
    for (const [name, fields, extra] of inputs)
      for (const roundTrip of [false, true])
        cases.push({
          id: `command-input.${family}.${name}.${roundTrip ? "json" : "live"}`,
          input: script.parse({
            family,
            fields: record(fields),
            roundTrip,
            ...extra,
          }),
        });
  }
  for (const [name, seq, at] of [
    ["nonfinite", { $number: "Infinity" }, { $number: "NaN" }],
    ["restored-null", null, null],
    ["negative-zero", { $number: "-0" }, { $number: "-0" }],
  ] as const)
    for (const roundTrip of [false, true])
      cases.push({
        id: `command-input.snapshot.${name}.${roundTrip ? "json" : "live"}`,
        input: script.parse({
          family: "snapshot",
          fields: record([
            ["key", "s"],
            ["seq", seq],
            ["at", at],
            ["payload", { n: 1 }],
            ["extra", true],
          ]),
          roundTrip,
        }),
      });
  return cases;
}
function execute(input: Script) {
  const baseDef =
    input.family === "process"
      ? intakeProcessDef<unknown>()
      : input.family === "replay"
        ? intakeReplayDef<unknown>()
        : snapshotWriteDef<unknown>();
  const def = input.name
    ? Cmd.define<string, CmdInput, undefined, readonly string[]>(input.name, {
        input: baseDef.schema.input,
        ok: baseDef.schema.ok,
        err: baseDef.errTags,
      })
    : baseDef;
  const cause = { capability: () => "opaque" };
  let called = 0;
  const known = input.family === "replay" ? "result" : "payload";
  const raw = decode(input.fields);
  const checked = validateSync<unknown>(
    def.schema.input,
    raw,
    "command input fixture",
  );
  if (checked.issues) throw Error("unchecked refused");
  const sourceOnly = {
    uncheckedAccepted: true,
    sameRaw: checked.value === raw,
  };
  let command: unknown;
  try {
    called++;
    if (input.failDecoder) throw cause;
    command = Reflect.apply(def, undefined, [checked.value]);
  } catch (error) {
    return {
      comparison: {
        status: "decoderError",
        sameCause: error === cause,
        called,
      },
      sourceOnly,
    };
  }
  if (!hasTag(command)) throw Error("tagged command");
  const original = command[known],
    reference = typeof original === "object" && original !== null;
  function view(value: Record<string, unknown>) {
    return {
      command: normalize(value),
      wire: JSON.stringify(value),
      keys: Object.keys(value).map(normalize),
      knownReferenceSame: reference ? value[known] === original : null,
    };
  }
  const before = view(command);
  if (input.roundTrip) {
    const next: unknown = JSON.parse(JSON.stringify(command));
    if (!hasTag(next)) throw Error("restored command");
    command = next;
  }
  if (input.mutate !== undefined) {
    if (!isRecord(original)) throw Error("mutable record");
    Reflect.set(original, "changed", decode(input.mutate));
  }
  if (!hasTag(command)) throw Error("tagged command");
  const after = view(command),
    contract = cmdContractOver([def], () => 17.25),
    settled: unknown = contract.settle(command, Outcome.ok(undefined));
  if (!hasTag(settled)) throw Error("settled command");
  contract.checkDispatch(command, settled);
  return {
    comparison: {
      status: "ok",
      called,
      before,
      after,
      settled: normalize(settled),
      provenanceAccepted: true,
    },
    sourceOnly,
  };
}
const native = z
  .object({
    id: z.string(),
    comparison: z.unknown(),
    observedRustCalls: z.array(z.string()),
  })
  .strict();
export function commandInputParity(options: {
  binary: string;
  reportFile?: string;
  caseIds?: string[];
}) {
  const cases = commandInputCases().filter(
      (c) => !options.caseIds || options.caseIds.includes(c.id),
    ),
    expected = cases.map((c) => execute(c.input));
  const p = spawnSync(options.binary, [], {
    input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(p.status, 0, p.stderr);
  const actual = p.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => native.parse(JSON.parse(line)));
  assert.equal(actual.length, cases.length);
  const failures = cases.flatMap((c, i) => {
    assert.equal(actual[i].id, c.id);
    try {
      assert.deepEqual(actual[i].comparison, expected[i].comparison);
      return [];
    } catch {
      return [
        {
          id: c.id,
          reference: expected[i].comparison,
          native: actual[i].comparison,
        },
      ];
    }
  });
  const report = {
    runtime: { node: process.version, v8: process.versions.v8 },
    binary: {
      path: options.binary,
      sha256: createHash("sha256")
        .update(readFileSync(options.binary))
        .digest("hex"),
    },
    compared: cases.length,
    passed: cases.length - failures.length,
    failures,
    cases: cases.map((c, i) => ({
      ...c,
      ...actual[i],
      sourceOnly: expected[i].sourceOnly,
      equal: !failures.some((f) => f.id === c.id),
    })),
    qualifications: [
      "Caller-supplied typed decoding, not new validation by Source unchecked<T>.",
      "InputFields retains plain own fields and typed payload handles, not arbitrary mutable unknown JS heap references/getters/prototypes.",
      "Default generic CommandSpec::parse_input continues to refuse without a decoder; only CmdDef::decode_input is the repaired route.",
    ],
  };
  const file = options.reportFile ?? "target/parity/command-input.json";
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { "native-bin": { type: "string" }, report: { type: "string" } },
    strict: true,
  });
  assert(values["native-bin"]);
  const r = commandInputParity({
    binary: values["native-bin"],
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      compared: r.compared,
      passed: r.passed,
      failures: r.failures,
    }),
  );
  if (r.failures.length) process.exitCode = 1;
}
