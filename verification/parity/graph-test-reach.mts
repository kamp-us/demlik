import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { z } from "zod";
import {
  rootReachOf,
  testReachViolations,
} from "../../packages/code-graph/src/boundaries/zones/test-reach.js";
import { globToRegExp } from "../../packages/code-graph/src/kinds/glob.js";
import {
  importLiterals,
  runtimeSpecifiers,
} from "../../packages/code-graph/src/syntax/imports.js";
import { sourceUnit } from "../../packages/code-graph/src/test-helpers/source-unit.js";

const binary = process.argv[2];
assert.ok(binary, "provide the compiled boundary domain driver");
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
const edge = z.object({
  specifier: z.string(),
  target: z.string().nullable(),
  typeOnly: z.boolean(),
  kind: z.enum(["static", "export-from", "dynamic"]),
});
const file = z
  .object({
    file: z.string(),
    importEdges: z.array(edge),
    runtimeSpecifiers: z.array(z.string()),
  })
  .strict();
const input = z
  .object({
    scope: z.string(),
    globs: z.array(z.string()),
    files: z.array(file),
    tests: z.array(z.number().int().nonnegative()),
  })
  .strict();
type Input = z.infer<typeof input>;
type File = z.infer<typeof file>;
type Edge = z.infer<typeof edge>;
const cases: { id: string; input: Input }[] = [];
function add(id: string, patch: Partial<Input> = {}) {
  cases.push({
    id,
    input: input.parse({
      scope: "services/shop",
      globs: ["src/root.ts"],
      files: [],
      tests: [],
      ...patch,
    }),
  });
}
function syntaxFile(
  name: string,
  source: string,
  targets: Record<string, string | null> = {},
): File {
  const syntax = sourceUnit(source, name).syntax;
  return {
    file: name,
    importEdges: importLiterals(syntax).map((item) => ({
      specifier: item.specifier,
      kind: item.kind,
      typeOnly: item.typeOnly,
      target: Object.hasOwn(targets, item.specifier)
        ? targets[item.specifier]
        : null,
    })),
    runtimeSpecifiers: [...runtimeSpecifiers(syntax)],
  };
}
const root = syntaxFile(
  "src/root.ts",
  "export const root=1; export type Root=number",
);
const helper = syntaxFile("src/helper.ts", "export {root} from './root'", {
  "./root": "src/root.ts",
});
add("disabled", { files: [root, helper], globs: [], tests: [1] });
add("root-only", { files: [root], tests: [0] });
for (const [index, source] of [
  "import {root} from './root'",
  "import type {Root} from './root'",
  "import {type Root} from './root'",
  "export {root} from './root'",
  "export type {Root} from './root'",
  "export {type Root} from './root'",
  "import('./root')",
  "require('./root')",
  "import './root'",
].entries()) {
  add(`syntax-${index}`, {
    files: [
      root,
      syntaxFile("src/a.test.ts", source, { "./root": "src/root.ts" }),
    ],
    tests: [1],
  });
}
add("transitive-first-hop", {
  files: [
    root,
    helper,
    syntaxFile("src/a.test.ts", "import './helper'", {
      "./helper": "src/helper.ts",
    }),
  ],
  tests: [1, 2],
});
add("isolated-helper", {
  files: [
    root,
    syntaxFile("src/helper.ts", "export const isolated=1"),
    syntaxFile("src/a.test.ts", "import './helper'", {
      "./helper": "src/helper.ts",
    }),
  ],
  tests: [2],
});
for (const kind of ["static", "export-from", "dynamic"] as const)
  for (const typeOnly of [false, true])
    for (const runtime of [false, true]) {
      const item: File = {
        file: "src/a.test.ts",
        importEdges: [
          { specifier: "./root", target: "src/root.ts", typeOnly, kind },
        ],
        runtimeSpecifiers: runtime ? ["./root"] : [],
      };
      add(`facts-${kind}-${typeOnly}-${runtime}`, {
        files: [root, item],
        tests: [1],
      });
    }
for (const [first, second] of [
  ["./first", "./second"],
  ["./second", "./first"],
  ["__proto__", "constructor"],
  ["10", "2"],
]) {
  const edges: Edge[] = [
    { specifier: first, target: "src/root.ts", typeOnly: true, kind: "static" },
    {
      specifier: second,
      target: "src/root.ts",
      typeOnly: false,
      kind: "dynamic",
    },
  ];
  add(`first-specifier-${first}`, {
    files: [
      root,
      {
        file: "src/a.test.ts",
        importEdges: edges,
        runtimeSpecifiers: [first, second],
      },
    ],
    tests: [1],
  });
  add(`only-second-opens-${first}`, {
    files: [
      root,
      {
        file: "src/a.test.ts",
        importEdges: edges,
        runtimeSpecifiers: [second],
      },
    ],
    tests: [1],
  });
}
const cycleA = syntaxFile("src/a.ts", "import './b'", { "./b": "src/b.ts" });
const cycleB = syntaxFile("src/b.ts", "import './a'; import './root'", {
  "./a": "src/a.ts",
  "./root": "src/root.ts",
});
add("cycle-to-root", { files: [root, cycleA, cycleB], tests: [1, 2] });
add("cycle-without-root", { files: [cycleA, cycleB], tests: [0, 1] });
add("root-is-a-test", {
  files: [root, helper],
  globs: ["src/helper.ts"],
  tests: [1],
});
for (const globs of [
  ["services/shop/src/root.ts"],
  ["**/root.ts"],
  ["src/*.ts"],
  ["missing"],
  ["src/root.ts", "src/helper.ts"],
]) {
  add(`globs-${JSON.stringify(globs)}`, {
    globs,
    files: [root, helper],
    tests: [0, 1],
  });
}
for (const scope of [".", "services/\ud800", ""])
  add(`scope-${JSON.stringify(scope)}`, {
    scope,
    files: [root, helper],
    tests: [1],
  });
add("unloaded-target", {
  files: [
    root,
    {
      file: "src/a.test.ts",
      importEdges: [
        {
          specifier: "./missing",
          target: "src/missing.ts",
          typeOnly: false,
          kind: "static",
        },
      ],
      runtimeSpecifiers: ["./missing"],
    },
  ],
  tests: [1],
});
add("unresolved", {
  files: [root, syntaxFile("src/a.test.ts", "import './root'")],
  tests: [1],
});
add("no-files", {});
add("duplicate-file-facts", {
  files: [root, helper, { ...helper, importEdges: [] }],
  tests: [1, 2],
});
const legacy: File[] = [
  root,
  helper,
  syntaxFile("src/harness.ts", "import './helper'", {
    "./helper": "src/helper.ts",
  }),
];
for (let n = 0; n < 120; n++)
  legacy.push(
    syntaxFile(`src/feature/case-${n}.test.ts`, "import '../harness'", {
      "../harness": "src/harness.ts",
    }),
  );
for (let n = 0; n < 100; n++)
  legacy.push(syntaxFile(`src/unit-${n}.test.ts`, "export const isolated=1"));
add("legacy-120-tests", {
  files: legacy,
  tests: legacy.map((_, index) => index),
});
const chain: File[] = [root];
for (let n = 1; n <= 5000; n++)
  chain.push({
    file: `src/chain-${n}.ts`,
    importEdges: [
      {
        specifier: "./next",
        target: n === 1 ? "src/root.ts" : `src/chain-${n - 1}.ts`,
        typeOnly: false,
        kind: "static",
      },
    ],
    runtimeSpecifiers: ["./next"],
  });
add("iterative-5000-chain", { files: chain, tests: [5000] });
assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
const expected = cases.map(({ input }) => {
  const files = input.files.map((item) => ({
    ...item,
    runtimeSpecifiers: new Set(item.runtimeSpecifiers),
  }));
  const reach = rootReachOf(input.globs.map(globToRegExp), input.scope, files);
  return {
    roots: [...reach.roots],
    inReach: [...reach.inReach],
    violations: input.tests.map((index) =>
      testReachViolations(reach, input.scope, files[index]),
    ),
    sameEmpty: reach === rootReachOf([], input.scope, []),
  };
});
assert.equal(
  expected[cases.findIndex((item) => item.id === "transitive-first-hop")]
    .violations[1][0].to,
  "services/shop/src/helper.ts",
);
assert.equal(
  expected[
    cases.findIndex((item) => item.id === "legacy-120-tests")
  ].violations.flat().length,
  122,
);
const invalid = [
  {
    id: "missing-files",
    operation: "code_graph.test-reach",
    input: { scope: ".", globs: [], tests: [] },
  },
  {
    id: "wrong-globs",
    operation: "code_graph.test-reach",
    input: { scope: ".", globs: 1, files: [], tests: [] },
  },
  {
    id: "wrong-index",
    operation: "code_graph.test-reach",
    input: { scope: ".", globs: [], files: [], tests: [1] },
  },
  {
    id: "extra-field",
    operation: "code_graph.test-reach",
    input: { scope: ".", globs: [], files: [], tests: [], extra: true },
  },
];
const child = spawnSync(binary, [], {
  encoding: "utf8",
  input: [
    ...cases.map((item) => ({ ...item, operation: "code_graph.test-reach" })),
    ...invalid,
  ]
    .map((item) => `${JSON.stringify(item)}\n`)
    .join(""),
  maxBuffer: 32 * 1024 * 1024,
});
if (child.error) throw child.error;
assert.equal(child.status, 0, child.stderr);
const answer = z.object({
  id: z.string().nullable(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  observedCalls: z.array(z.string()),
});
const answers = child.stdout
  .trim()
  .split("\n")
  .map((line) => answer.parse(JSON.parse(line)));
assert.equal(answers.length, cases.length + invalid.length);
const failures: {
  id: string;
  reference: { ok: true; output: unknown };
  native: z.infer<typeof answer>;
  message: string;
}[] = [];
for (const [index, item] of cases.entries()) {
  assert.equal(answers[index].id, item.id);
  assert.equal(answers[index].ok, true, answers[index].error);
  try {
    assert.deepEqual(answers[index].output, expected[index]);
  } catch (error) {
    failures.push({
      id: item.id,
      reference: { ok: true, output: expected[index] },
      native: answers[index],
      message: String(error),
    });
  }
}
for (const item of answers.slice(cases.length)) {
  assert.equal(item.ok, false);
  assert(item.error);
}
const report = {
  reference: { node: process.version, v8: process.versions.v8 },
  passed: cases.length - failures.length,
  attempted: cases.length,
  failures,
  rejectedInvalidInputs: invalid.length,
  nativeApis: [...new Set(answers.flatMap((item) => item.observedCalls))],
  cases: answers,
};
if (process.argv[3])
  fs.writeFileSync(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    ...report,
    cases: undefined,
    failures: failures.map((item) => ({ id: item.id, message: item.message })),
  }),
);
if (failures.length) process.exitCode = 1;
