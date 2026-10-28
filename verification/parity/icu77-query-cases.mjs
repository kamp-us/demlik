const edge = (a, b, weight = 1) => ({ a, b, weight });
const link = (from, to, typeOnly = false) => ({ from, to, typeOnly });
const files = (names) =>
  Object.fromEntries(
    names.map((file) => [file, "export function work(){return 1}\n"]),
  );
const leftRight = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => {
    const label = [
      "Z",
      "a",
      "é",
      "é-x",
      "10",
      "2",
      "𐀀",
      "\ue000",
      "b",
      "c",
      "d",
      "e",
    ][i];
    return [`left/${label}.ts`, "export function work(){return 1}\n"];
  }),
);
const pairs = Object.keys(leftRight).map((left) => [
  left,
  left.replace("left/", "right/"),
]);
export const workflowFiles = {
  "package.json": '{"private":true}',
  "packages/a/package.json": '{"name":"a"}',
  "packages/b/package.json": '{"name":"b"}',
  "packages/a/src/entry.ts":
    'import {worker} from "../../b/src/worker";import {helper} from "./helper";export function entry(){return worker()+helper()}\n',
  "packages/a/src/helper.ts": "export function helper(){return 1}\n",
  "packages/b/src/worker.ts":
    'import {core} from "./core";export function worker(){return core()}\n',
  "packages/b/src/core.ts": "export function core(){return 2}\n",
  "packages/a/src/flow.ts":
    'import {other} from "../../b/src/other";export function flow(){return other()}\n',
  "packages/b/src/other.ts": "export function other(){return 3}\n",
  "packages/a/src/unused.ts": "export function unused(){return 4}\n",
  "packages/a/src/entry.test.ts":
    'import {entry} from "./entry";export function testEntry(){return entry()}\n',
};
export const cases = [
  { id: "partition-empty", operation: "partition", nodes: [], edges: [] },
  {
    id: "partition-nonlexical-membership",
    operation: "partition",
    nodes: ["z", "a", "m"],
    edges: [],
  },
  {
    id: "partition-duplicates-self-unknown",
    operation: "partition",
    nodes: ["z", "a", "z", "m"],
    edges: [
      edge("z", "z", 100),
      edge("z", "missing", 9),
      edge("z", "a", 2),
      edge("z", "a", 3),
    ],
  },
  {
    id: "partition-strength-before-name",
    operation: "partition",
    nodes: ["Z", "middle", "a"],
    edges: [edge("middle", "Z"), edge("middle", "a")],
  },
  {
    id: "partition-candidate-collation-tie",
    operation: "partition",
    nodes: ["middle", "Z", "a"],
    edges: [edge("middle", "Z"), edge("middle", "a")],
  },
  {
    id: "partition-canonical-stable-tie",
    operation: "partition",
    nodes: ["é", "é", "A", "a"],
    edges: [edge("é", "A"), edge("é", "a"), edge("é", "é", 0.125)],
  },
  {
    id: "partition-ordinal-fold-orientation",
    operation: "partition",
    nodes: ["𐀀", "\ue000", "2", "10"],
    edges: [edge("𐀀", "\ue000", 4), edge("2", "10", 4), edge("𐀀", "2", 0.25)],
  },
  {
    id: "partition-fractional-eps-priority",
    operation: "partition",
    nodes: ["z", "b", "a", "q"],
    edges: [
      edge("z", "b", 0.3333333333333333),
      edge("b", "a", 1e-12),
      edge("a", "q", 0.3333333333333333),
    ],
  },
  {
    id: "partition-zero-and-negative-weights",
    operation: "partition",
    nodes: ["z", "a", "m"],
    edges: [edge("z", "a", 0), edge("z", "m", -1), edge("a", "m", 1)],
  },
  { id: "report-empty", operation: "reports", files: {} },
  {
    id: "report-isolated-test-and-excluded-links",
    operation: "reports",
    files: files(["a.ts", "b.ts", "b.test.ts"]),
    moduleLinks: [
      link("a.ts", "a.ts"),
      link("a.ts", "missing.ts"),
      link("a.ts", null),
      link("a.ts", "b.ts", true),
      link("b.test.ts", "a.ts"),
    ],
  },
  {
    id: "report-duplicate-call-and-module-weights",
    operation: "reports",
    files: files([
      "left/a.ts",
      "right/b.ts",
      "left/c.ts",
      "right/d.ts",
      "left/isolated.ts",
    ]),
    moduleLinks: [
      link("left/a.ts", "right/b.ts"),
      link("left/a.ts", "right/b.ts"),
      link("left/c.ts", "right/d.ts"),
    ],
    callLinks: [
      { callerId: "left/a.ts:work", calleeId: "right/b.ts:work" },
      { callerId: "left/a.ts:work", calleeId: "right/b.ts:work" },
      { callerId: "left/a.ts:work", calleeId: "unknown:call" },
    ],
  },
  {
    id: "report-size-before-label",
    operation: "reports",
    files: files([
      "left/a.ts",
      "right/a.ts",
      "left/z.ts",
      "right/z.ts",
      "other/z.ts",
    ]),
    moduleLinks: [
      link("left/a.ts", "right/a.ts"),
      link("left/z.ts", "right/z.ts"),
      link("right/z.ts", "other/z.ts"),
    ],
  },
  {
    id: "report-twelve-scattered-split-stable-names",
    operation: "reports",
    files: {
      ...leftRight,
      ...files(pairs.map(([, right]) => right)),
      "left/isolated.ts": "export function work(){return 0}\n",
    },
    moduleLinks: pairs.map(([a, b]) => link(a, b)),
  },
  {
    id: "report-ordinal-path-pair-orientation",
    operation: "reports",
    files: files(["é-x/a.ts", "é-y/b.ts", "𐀀/a.ts", "\ue000/b.ts"]),
    moduleLinks: [link("é-x/a.ts", "é-y/b.ts"), link("𐀀/a.ts", "\ue000/b.ts")],
  },
  {
    id: "interface-nested-consumers-export-order",
    operation: "reports",
    files: {
      "packages/a/z.ts":
        "export function Zoo(){return 1}\nexport function Alpha(){return 2}\n",
      "packages/a/nested/entry.ts": "export function inner(){return 1}\n",
      "packages/ab/file.ts": "export function prefixOnly(){return 1}\n",
      "packages/b/use.ts": "function local(){return 1}\n",
      "packages/a/z.test.ts": "export function test(){return 1}\n",
    },
    packageDirs: [
      "packages/a",
      "packages/a/nested",
      "packages/ab",
      "packages/b",
      "",
    ],
    identifierFiles: {
      Zoo: [
        "packages/a/z.ts",
        "packages/a/same.ts",
        "packages/b/Z.ts",
        "packages/b/a.ts",
        "packages/b/é.ts",
        "packages/b/é.ts",
        "packages/b/a.ts",
      ],
      Alpha: [],
      inner: ["packages/a/z.ts", "packages/ab/file.ts"],
    },
    lookupFiles: [
      "packages/a/nested/entry.ts",
      "packages/ab/file.ts",
      "packages/abc/file.ts",
    ],
  },
  {
    id: "interface-count-before-package-label",
    operation: "reports",
    files: {
      "a/a.ts": "export function one(){return 1}\n",
      "z/a.ts":
        "export function three(){return 1}\nexport function two(){return 2}\n",
      "m/a.ts": "export function tie(){return 1}\n",
    },
    packageDirs: ["a", "z", "m"],
    identifierFiles: { one: ["z/a.ts"], two: ["m/a.ts"], three: [] },
  },
  {
    id: "interface-utf16-longest-prefix",
    operation: "reports",
    files: {
      "𐀀/pkg/a.ts": "export function astral(){return 1}\n",
      "\ue000/pkg/a.ts": "export function privateUse(){return 1}\n",
    },
    packageDirs: ["𐀀", "𐀀/pkg", "\ue000/pkg"],
    identifierFiles: {
      astral: ["\ue000/pkg/a.ts"],
      privateUse: ["𐀀/pkg/a.ts"],
    },
    lookupFiles: ["𐀀/pkg/a.ts", "𐀀/pkg-more/a.ts", "\ue000/pkg/a.ts"],
  },
  {
    id: "two-package-real-graph-workflow",
    operation: "workflow",
    files: workflowFiles,
    packageDirs: ["packages/a", "packages/b"],
  },
];
export function filesFor(item) {
  return item.operation === "workflow"
    ? {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            types: [],
            target: "es2022",
            module: "esnext",
            moduleResolution: "bundler",
          },
          include: ["**/*.ts"],
        }),
        ...item.files,
      }
    : (item.files ?? {});
}
