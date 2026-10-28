const fn = (id, file, more = {}) => ({ id, file, ...more });
const target = (file, id = file, startLine = 1) => ({
  type: "function",
  file,
  id,
  startLine,
});
const smell = (
  file,
  kind,
  severity = "warn",
  value = 1,
  id = file,
  more = {},
) => ({
  kind,
  target: target(file, id),
  severity,
  value,
  threshold: 1,
  ...more,
});
const words = [
  "long-function",
  "deep-nesting",
  "high-complexity",
  "dense-undocumented",
  "big-file",
  "high-fan-in",
  "deep-call-chain",
  "directory-sprawl",
  "dependency-cycle",
  "cross-boundary-import",
];
const reasons = [
  "referenced-in-non-test-file",
  "public-entry-surface",
  "test-support-surface",
];
const functions = [
  fn("z:Z", "z.ts", {
    loc: 40,
    complexity: 3,
    smells: [smell("z.ts", "long-function")],
  }),
  fn("a:a", "a.ts", {
    loc: 20,
    complexity: 4,
    smells: [smell("a.ts", "high-complexity"), smell("a.ts", "deep-nesting")],
  }),
  fn("m:m", "m.ts", {
    loc: 60,
    complexity: 2,
    edges: {
      calls: [],
      calledBy: [
        { callerId: "m:m", line: 1 },
        { callerId: "caller", line: 2 },
        { callerId: "caller", line: 3 },
      ],
      callChainDepth: 1,
    },
  }),
];
const cheap = {
  "package.json": '{"private":true}',
  "pnpm-workspace.yaml": "packages: []\n",
  "z.ts":
    "export function Z(n:number){if(n>0){if(n>1)return n;return 0;}return -1;}\n",
  "a.ts": "export function a(n:number){if(n>2)return n;return 1;}\n",
  "m.ts": "export function m(){return 2;}\n",
};
const go = {
  "package.json": '{"private":true}',
  "pnpm-workspace.yaml": "packages: [packages/*]\n",
  "tsconfig.json":
    '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","types":[]},"include":["packages/**/*.ts"]}',
  "packages/a/package.json": '{"name":"a"}',
  "packages/b/package.json": '{"name":"b"}',
  "packages/a/entry.ts":
    "import {helper} from './helper.js';import {work} from '../b/work.js';export function main(n:number){if(n>0)return helper(n)+work(n);return 0;}\n",
  "packages/a/helper.ts": "export function helper(n:number){return n+1;}\n",
  "packages/b/work.ts":
    "import {cycle} from './cycle.js';export function work(n:number){if(n>1)return cycle(n-1);return 1;}\n",
  "packages/b/cycle.ts":
    "import {work} from './work.js';export function cycle(n:number){return n>2?work(n-1):0;}\n",
};
export const cases = [
  { id: "closed-kind-pair-matrix", mode: "kind-matrix", words },
  { id: "withheld-tally-permutations", mode: "tally", reasons },
  {
    id: "function-rule-order",
    mode: "function",
    thresholds: {
      longFunctionLoc: 3,
      highComplexity: 2,
      deepNesting: 1,
      highFanIn: 1,
      deepCallChain: 1,
    },
    functions: [
      fn("bad", "z.ts", {
        loc: 9,
        complexity: 7,
        nestingDepth: 3,
        commentLines: 0,
        edges: {
          calls: [],
          calledBy: [
            { callerId: "bad", line: 1 },
            { callerId: "a", line: 2 },
            { callerId: "b", line: 3 },
          ],
          callChainDepth: 3,
        },
      }),
      fn("clean", "a.ts"),
    ],
  },
  {
    id: "module-coupling-facts",
    mode: "module",
    thresholds: { bigFileLoc: 4 },
    modules: [
      { file: "z.ts", loc: 20 },
      { file: "a.ts", loc: 2 },
    ],
    coupling: [{ cycleSize: 3, crossBoundaryOutCount: 5 }, null],
  },
  {
    id: "directory-threshold",
    mode: "directory",
    thresholds: { directorySprawl: 2 },
    directories: [
      { dir: "z", fileCount: 6 },
      { dir: "a", fileCount: 2 },
      { dir: ".", fileCount: 0 },
    ],
  },
  {
    id: "flat-mixed-locators",
    mode: "flat",
    smells: [
      smell("z.ts", "long-function"),
      smell("a.ts", "high-complexity", "high", 6, "a", {
        target: { type: "module", file: "a.ts" },
      }),
      smell("a.ts", "directory-sprawl", "warn", 2, "dir", {
        target: { type: "directory", dir: "a" },
      }),
      smell("a.ts", "long-function", "warn", 4, "line10", {
        target: target("a.ts", "line10", 10),
      }),
      smell("a.ts", "long-function", "warn", 4, "line2", {
        target: target("a.ts", "line2", 2),
      }),
    ],
  },
  {
    id: "flat-kind-severity-value",
    mode: "flat",
    smells: [
      smell("same.ts", "long-function", "warn", 3, "warn3"),
      smell("same.ts", "long-function", "high", 5, "high5"),
      smell("same.ts", "long-function", "high", 9, "high9"),
      smell("same.ts", "deep-nesting", "warn", 1, "kind"),
      smell("same.ts", "long-function", "high", 5, "equal-later"),
    ],
  },
  {
    id: "flat-unicode-stable-ties",
    mode: "flat",
    smells: [
      "z.ts",
      "10.ts",
      "2.ts",
      "é.ts",
      "e\u0301.ts",
      "a.ts",
      "A.ts",
      "\ue000.ts",
      "\u{10000}.ts",
    ].map((file, i) => smell(file, "long-function", "warn", 1, `id${i}`)),
  },
  ...["rot", "impact", "complexity", "size"].map((axis) => ({
    id: `plan-${axis}`,
    mode: "plan",
    axis,
    functions,
  })),
  {
    id: "plan-null-zero-self-fanin",
    mode: "plan",
    axis: "impact",
    functions: [
      fn("none", "z.ts"),
      fn("zero", "a.ts", {
        edges: { calls: [], calledBy: [], callChainDepth: 0 },
      }),
      fn("self", "m.ts", {
        edges: {
          calls: [],
          calledBy: [
            { callerId: "self", line: 1 },
            { callerId: "self", line: 2 },
          ],
          callChainDepth: 0,
        },
      }),
      fn("once", "b.ts", {
        edges: {
          calls: [],
          calledBy: [
            { callerId: "x", line: 1 },
            { callerId: "x", line: 2 },
          ],
          callChainDepth: 0,
        },
      }),
    ],
  },
  {
    id: "plan-line-before-id",
    mode: "plan",
    axis: "rot",
    functions: [
      fn("A", "same.ts", { startLine: 20, endLine: 20 }),
      fn("z", "same.ts", { startLine: 2, endLine: 2 }),
      fn("a", "same.ts", { startLine: 2, endLine: 2 }),
      fn("same", "z.ts"),
    ],
  },
  {
    id: "plan-unicode-numeric-keys",
    mode: "plan",
    axis: "rot",
    functions: [
      "10",
      "2",
      "é",
      "e\u0301",
      "a",
      "A",
      "\ue000",
      "\u{10000}",
    ].flatMap((word, i) => [fn(`id${i}`, `${word}.ts`), fn(word, "shared.ts")]),
  },
  {
    id: "plan-equal-input-stability",
    mode: "plan",
    axis: "rot",
    functions: [
      fn("same", "same.ts", {
        smells: [smell("same.ts", "long-function", "warn", 1)],
      }),
      fn("same", "same.ts", {
        smells: [smell("same.ts", "long-function", "warn", 2)],
      }),
      fn("same", "same.ts", {
        smells: [smell("same.ts", "long-function", "high", 3)],
      }),
    ],
  },
  { id: "empty-null-json-guards", mode: "empty", reasons },
  {
    id: "plan-top20-render-modes",
    mode: "render-plan",
    axis: "size",
    functions: Array.from({ length: 24 }, (_, i) =>
      fn(`id${23 - i}`, `file${i % 3}.ts`, {
        loc: 30 - i,
        startLine: i + 1,
        endLine: i + 2,
      }),
    ),
  },
  {
    id: "summary-top10-worst",
    mode: "cheap",
    thresholds: { highComplexity: 1 },
    files: Object.fromEntries(
      Array.from({ length: 14 }, (_, i) => [
        `src/f${13 - i}.ts`,
        `export function f${i}(x:number){if(x>0)return x;return 0;}\n`,
      ]),
    ),
  },
  {
    id: "html-plan-original-summary",
    mode: "html",
    functions,
    modules: [
      { file: "z.ts", loc: 40, functionIds: ["z:Z"] },
      { file: "a.ts", loc: 20, functionIds: ["a:a"] },
      { file: "m.ts", loc: 60, functionIds: ["m:m"] },
    ],
  },
  {
    id: "cli-priority-initial-exit-out-workflow",
    mode: "cli",
    files: cheap,
    actions: [
      { id: "plan-text", flags: ["--plan"] },
      { id: "plan-json", flags: ["--plan", "--json"] },
      { id: "plan-pretty", flags: ["--plan", "--json", "--pretty"] },
      { id: "file", flags: ["--plan", "--out", "result.txt"] },
      { id: "overwrite", flags: ["--plan", "--json", "--out", "result.txt"] },
      { id: "initial7", flags: ["--plan", "--json"], initial: 7 },
      { id: "plan-before-smells", flags: ["--plan", "--smells"] },
      { id: "graph-before-plan", flags: ["--graph", "--plan", "--json"] },
      { id: "unknown-axis-warning", flags: ["--plan", "--by", "unknown"] },
      { id: "impact-refusal", flags: ["--plan", "--by", "impact"], code: 2 },
    ],
  },
  {
    id: "real-cheap-three-modules",
    mode: "cheap",
    thresholds: { highComplexity: 1, longFunctionLoc: 2 },
    files: cheap,
  },
  {
    id: "real-go-two-packages",
    mode: "go",
    thresholds: { highComplexity: 1, highFanIn: 0 },
    files: go,
  },
];
