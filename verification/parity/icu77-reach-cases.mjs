const link = (callerId, calleeId) => ({ callerId, calleeId });
const entry = (reach = "public", guards = []) => ({
  kind: "entry",
  reach,
  guards,
});
const effect = { kind: "effect" },
  auth = { kind: "auth" };
const simple = {
  "flow.ts":
    "export function entry(){}\nexport function Z(){}\nexport function a(){}\nexport function effect(){}\n",
};
export const workflowFiles = {
  "package.json": '{"private":true}',
  "packages/api/package.json": '{"name":"api"}',
  "packages/core/package.json": '{"name":"core"}',
  "packages/api/main.ts":
    'import {helper,callback} from "../core/worker";declare function register(fn:()=>number):void;export function main(){helper();register(callback)}\n',
  "packages/core/worker.ts":
    'import {write} from "./effects";export function helper(){return write()}\nexport function callback(){return 2}\n',
  "packages/core/private.ts":
    "export function dead(){return 3}\nexport function onlyTest(){return 4}\n",
  "packages/core/effects.ts": "export function write(){return 1}\n",
  "packages/core/worker.test.ts":
    'import {onlyTest} from "./private";export function test(){return onlyTest()}\n',
  "packages/core/index.ts": 'export {callback} from "./worker";\n',
  "packages/api/unused.ts": "export function unused(){return 5}\n",
};
export const cases = [
  { id: "reach-empty", files: {} },
  {
    id: "adjacency-nonlexical-outer-membership",
    files: {
      "z.ts": "export function z(){}\n",
      "a.ts": "export function a(){}\n",
      "m.ts": "export function m(){}\n",
    },
    functionOrder: ["z.ts:z", "a.ts:a", "m.ts:m"],
    calls: [link("z.ts:z", "m.ts:m")],
    referencesById: { "z.ts:z": ["a.ts:a", "m.ts:m", "missing"] },
    roots: ["z.ts:z"],
  },
  {
    id: "calls-and-reference-union",
    files: simple,
    calls: [
      link("flow.ts:entry", "flow.ts:Z"),
      link("flow.ts:entry", "flow.ts:Z"),
      link("flow.ts:entry", "external:unknown"),
    ],
    referencesById: { "flow.ts:entry": ["flow.ts:a", "flow.ts:Z", "missing"] },
    roots: ["flow.ts:entry"],
  },
  {
    id: "unknown-and-duplicate-root-order",
    files: simple,
    roots: ["missing", "flow.ts:a", "missing", "flow.ts:Z"],
    moduleScopeRoots: ["missing", "flow.ts:a", "missing"],
  },
  {
    id: "cycles-self-and-duplicate-calls",
    files: simple,
    calls: [
      link("flow.ts:entry", "flow.ts:entry"),
      link("flow.ts:entry", "flow.ts:a"),
      link("flow.ts:a", "flow.ts:entry"),
      link("flow.ts:a", "flow.ts:effect"),
    ],
    roots: ["flow.ts:entry"],
    kinds: { "flow.ts:entry": entry(), "flow.ts:effect": effect },
  },
  {
    id: "locale-adjacency-shortest-witness",
    files: simple,
    calls: [
      link("flow.ts:entry", "flow.ts:Z"),
      link("flow.ts:entry", "flow.ts:a"),
      link("flow.ts:Z", "flow.ts:effect"),
      link("flow.ts:a", "flow.ts:effect"),
    ],
    kinds: { "flow.ts:entry": entry(), "flow.ts:effect": effect },
  },
  {
    id: "locale-entry-seed-first-witness",
    files: simple,
    calls: [
      link("flow.ts:Z", "flow.ts:effect"),
      link("flow.ts:a", "flow.ts:effect"),
    ],
    kinds: {
      "flow.ts:Z": entry(),
      "flow.ts:a": entry(),
      "flow.ts:effect": effect,
    },
  },
  {
    id: "entry-reach-precedence",
    files: {
      "flow.ts":
        "export function Zpublic(){}\nexport function aservice(){}\nexport function aplatform(){}\nexport function effect(){}\n",
    },
    calls: [
      link("flow.ts:Zpublic", "flow.ts:effect"),
      link("flow.ts:aservice", "flow.ts:effect"),
      link("flow.ts:aplatform", "flow.ts:effect"),
    ],
    kinds: {
      "flow.ts:Zpublic": entry(),
      "flow.ts:aservice": entry("service-binding"),
      "flow.ts:aplatform": entry("platform"),
      "flow.ts:effect": effect,
    },
  },
  {
    id: "guarded-and-unguarded-rejoin",
    files: {
      "flow.ts":
        "export function entry(){}\nexport function guard(){}\nexport function hop(){}\nexport function join(){}\nexport function effect(){}\n",
    },
    calls: [
      link("flow.ts:entry", "flow.ts:guard"),
      link("flow.ts:entry", "flow.ts:hop"),
      link("flow.ts:guard", "flow.ts:join"),
      link("flow.ts:hop", "flow.ts:join"),
      link("flow.ts:join", "flow.ts:effect"),
    ],
    kinds: {
      "flow.ts:entry": entry(),
      "flow.ts:guard": auth,
      "flow.ts:effect": effect,
    },
  },
  {
    id: "guarded-entry-does-not-mask-other-entry",
    files: simple,
    calls: [
      link("flow.ts:Z", "flow.ts:effect"),
      link("flow.ts:a", "flow.ts:effect"),
    ],
    kinds: {
      "flow.ts:Z": entry("public", ["guard"]),
      "flow.ts:a": entry(),
      "flow.ts:effect": effect,
    },
  },
  {
    id: "unreachable-category-before-id",
    files: {
      "a.ts": "export function onlyTest(){}\n",
      "z.ts": "export function dead(){}\n",
    },
    identifierFiles: {
      onlyTest: ["t2.test.ts", "a.ts", "t1.test.ts", "t2.test.ts"],
    },
  },
  {
    id: "withheld-reason-before-id",
    files: {
      "z/index.ts": "export function publicZ(){}\n",
      "m/used.ts": "export function mentioned(){}\n",
      "a/support.ts": "export function support(){}\n",
    },
    identifierFiles: { mentioned: ["m/used.ts", "consumer.ts"] },
    testSupport: [{ key: "support", patterns: ["support\\.ts$"] }],
  },
  {
    id: "unexported-and-test-exclusions",
    files: {
      "a.ts": "function hidden(){}\nexport function visible(){}\n",
      "a.test.ts": "export function test(){}\n",
    },
    identifierFiles: { visible: ["a.ts"] },
  },
  {
    id: "recursive-type-only-barrel-surface",
    files: {
      "p/index.ts": "export function root(){}\n",
      "p/leaf.ts": "export function leaf(){}\n",
      "p/other.ts": "export function other(){}\n",
    },
    moduleLinks: [
      {
        from: "p/index.ts",
        to: "p/leaf.ts",
        kind: "export-from",
        typeOnly: true,
      },
      { from: "p/leaf.ts", to: "p/other.ts", kind: "export-from" },
      { from: "p/other.ts", to: "p/index.ts", kind: "export-from" },
    ],
  },
  {
    id: "explicit-entry-and-export-pattern",
    files: {
      "entry.ts": "export function explicit(){}\n",
      "public/leaf.ts": "export function pub(){}\n",
      "private/leaf.ts": "export function dead(){}\n",
    },
    extraEntryFiles: ["entry.ts", "missing.ts"],
    exportPatterns: ["^public/"],
  },
  {
    id: "duplicate-names-use-original-name-occurrences",
    files: {
      "a.ts": "export function shared(){}\n",
      "b.ts": "export function shared(){}\n",
    },
    identifierFiles: { shared: ["a.ts", "b.ts", "tests.test.ts"] },
  },
  {
    id: "module-callback-root-and-test-root-separation",
    files: simple,
    referencesById: { "flow.ts:entry": ["flow.ts:a"] },
    moduleScopeRoots: ["flow.ts:entry"],
    testModuleScopeRoots: ["flow.ts:Z"],
  },
  {
    id: "two-package-real-reachability-workflow",
    operation: "workflow",
    files: workflowFiles,
    kinds: {
      "packages/api/main.ts:main": entry(),
      "packages/core/effects.ts:write": effect,
    },
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
    : item.files;
}
