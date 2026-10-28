const edge = (target, extra = {}) => ({
  target,
  specifier: target ?? "missing",
  kind: "static",
  typeOnly: false,
  ...extra,
});
const module = (file, targets = []) => ({
  file,
  edges: targets.map((target) =>
    typeof target === "string" ? edge(target) : target,
  ),
});
export const workflowFiles = {
  "package.json": '{"private":true}',
  "packages/a/package.json": '{"name":"a"}',
  "packages/Z/package.json": '{"name":"Z"}',
  "packages/a/a.ts":
    'import {b}from "../Z/b";export function a(){return b()}\n',
  "packages/Z/b.ts": 'import {a}from "../a/a";export function b(){return a}\n',
  "packages/Z/bridge.ts":
    'import {a}from "../a/a";export function bridge(){return a()}\n',
  "packages/a/alone.ts": "export function alone(){return 1}\n",
};
export const cases = [
  { id: "coupling-empty", modules: [] },
  {
    id: "coupling-input-map-order",
    modules: [module("z.ts"), module("a.ts"), module("m.ts")],
  },
  {
    id: "value-edge-exclusions",
    modules: [
      module("a.ts", [
        "b.ts",
        "b.ts",
        edge("a.ts"),
        edge(null),
        edge("external.ts"),
        edge("c.ts", { typeOnly: true }),
        edge("b.ts", { kind: "dynamic" }),
      ]),
      module("b.ts"),
      module("c.ts"),
    ],
  },
  {
    id: "value-edge-kinds",
    modules: [
      module("a.ts", [
        edge("d.ts", { kind: "dynamic" }),
        edge("b.ts", { kind: "export-from" }),
        edge("c.ts"),
      ]),
      module("b.ts"),
      module("c.ts"),
      module("d.ts"),
    ],
  },
  {
    id: "value-edge-unicode-order",
    modules: [
      module("Z.ts", ["\ue000.ts", "a.ts"]),
      module("a.ts", ["\u{10000}.ts", "Z.ts"]),
      module("\ue000.ts"),
      module("\u{10000}.ts"),
    ],
  },
  {
    id: "value-edge-stable-normalization",
    modules: [
      module("é.ts", ["z.ts"]),
      module("é.ts", ["z.ts"]),
      module("z.ts"),
    ],
  },
  {
    id: "two-node-cycle",
    modules: [module("Z.ts", ["a.ts"]), module("a.ts", ["Z.ts"])],
  },
  {
    id: "multiple-cycles-bridge-isolate",
    modules: [
      module("Z.ts", ["z2.ts", "a.ts"]),
      module("z2.ts", ["Z.ts"]),
      module("a.ts", ["a2.ts"]),
      module("a2.ts", ["a.ts"]),
      module("isolate.ts"),
    ],
  },
  {
    id: "nested-package-boundaries",
    packageRoots: ["pkg", "pkg/nested", "pkg-extra"],
    modules: [
      module("pkg/nested/a.ts", ["pkg/Z.ts", "pkg-extra/c.ts"]),
      module("pkg/Z.ts", ["pkg/nested/a.ts"]),
      module("pkg-extra/c.ts"),
    ],
  },
  {
    id: "literal-tab-edge-collision",
    packageRoots: ["a\tb", "c", "a", "b\tc"],
    modules: [
      module("a\tb", ["c"]),
      module("a", ["b\tc"]),
      module("c"),
      module("b\tc"),
      module("a\tb/one", ["c/end"]),
      module("a/two", ["b\tc/end"]),
      module("c/end"),
      module("b\tc/end"),
    ],
  },
  {
    id: "rank-score-before-file",
    packageRoots: ["Z", "a", "b", "c"],
    modules: [
      module("Z/z.ts", ["a/a.ts", "b/b.ts", "c/c.ts"]),
      module("a/a.ts", ["Z/z.ts"]),
      module("b/b.ts"),
      module("c/c.ts"),
    ],
  },
  {
    id: "rank-equal-score-file-order",
    packageRoots: ["a", "Z", "target"],
    modules: [
      module("Z/z.ts", ["target/t.ts"]),
      module("a/a.ts", ["target/t.ts"]),
      module("target/t.ts"),
    ],
  },
  {
    id: "cross-boundary-group-order",
    packageRoots: ["a", "Z", "target", "other"],
    modules: [
      module("Z/z.ts", ["target/Z.ts", "other/x.ts"]),
      module("a/a.ts", ["target/a.ts"]),
      module("target/Z.ts"),
      module("target/a.ts"),
      module("other/x.ts"),
    ],
  },
  {
    id: "duplicate-module-first-map-slot",
    modules: [
      module("z.ts", ["a.ts"]),
      module("a.ts", ["z.ts"]),
      module("z.ts", ["m.ts"]),
      module("m.ts"),
    ],
  },
  { id: "render-early-guards", mode: "guards" },
  {
    id: "render-threshold-coupling",
    mode: "render",
    packageRoots: ["a", "Z"],
    modules: [module("Z/z.ts", ["a/a.ts"]), module("a/a.ts", ["Z/z.ts"])],
    files: {
      "a/package.json": '{"name":"a"}',
      "Z/package.json": '{"name":"Z"}',
    },
  },
  {
    id: "syntax-only-no-config",
    mode: "cheap",
    files: {
      "z.ts": "export function z(){}\n",
      "a.ts": "export function a(){}\n",
      "m.ts": "export function m(){}\n",
    },
  },
  { id: "two-package-official-go", mode: "workflow", files: workflowFiles },
];
export function filesFor(item) {
  return {
    ...(item.files ?? {}),
    ...(item.mode === "workflow"
      ? {
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
            },
            include: ["**/*.ts"],
          }),
        }
      : {}),
  };
}
export function modulesFor(item) {
  return (item.modules ?? []).map((row) => ({
    file: row.file,
    loc: 0,
    commentLines: 0,
    functionIds: [],
    imports: [],
    importedBy: [],
    importEdges: row.edges,
    isTest: false,
    smells: [],
  }));
}
