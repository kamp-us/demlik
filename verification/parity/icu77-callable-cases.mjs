const config = JSON.stringify({
  compilerOptions: {
    strict: true,
    types: [],
    target: "es2022",
    module: "esnext",
    moduleResolution: "bundler",
  },
  include: ["**/*.ts"],
});
const workflow = {
  "package.json": '{"name":"callable-workspace","private":true}',
  "packages/api/package.json":
    '{"name":"api","dependencies":{"data":"workspace:*"}}',
  "packages/data/package.json": '{"name":"data"}',
  "packages/data/src/store.ts":
    "export const z_CONST=1,a_CONST=2;\nexport function save(value:number){return value}\nexport function read(){return save(a_CONST)}\n",
  "packages/api/src/auth.ts": "export function authorize(){return true}\n",
  "packages/api/src/route.ts":
    'import {save as persist,z_CONST,a_CONST,read} from "../../data/src/store";\nimport {authorize} from "./auth";\nexport function GET(){authorize();persist(z_CONST);persist(a_CONST);return read()}\nexport const callback=GET;\n',
  "packages/api/src/factory.ts":
    "function factory(config:{z:()=>number,a:()=>number}){return ()=>{config.z();return config.a()}}\nconst work=factory({z(){return 1},a(){return 2}});\nexport function invoke(){return work()}\n",
};
export const cases = [
  {
    id: "syntax-line-before-name",
    operation: "syntax",
    files: {
      "a.ts":
        "export function Zoo(){return 1}\nexport function Alpha(){return 2}\n",
    },
  },
  {
    id: "syntax-duplicate-ordinal",
    operation: "syntax",
    files: {
      "a.ts":
        "const left={same(){return 1}},right={same(){return 2}};\nexport function root(){return left.same()+right.same()}\n",
    },
  },
  {
    id: "syntax-canonical-and-astral",
    operation: "syntax",
    files: {
      "é.ts": "export function é(){return 1}\nexport function é(){return 2}\n",
      "𐀀.ts": "export function astral(){return 3}\n",
      "\ue000.ts": "export function privateUse(){return 4}\n",
    },
  },
  {
    id: "edge-merge-constant-union",
    operation: "graph",
    files: {
      "model.ts":
        "export const z_CONST=1,a_CONST=2;export function target(x:number){return x}\n",
      "entry.ts":
        'import {z_CONST,a_CONST,target} from "./model";\nexport function run(){target(z_CONST);target(a_CONST);target(z_CONST)}\n',
    },
  },
  {
    id: "edge-numeric-lines-and-inversion",
    operation: "graph",
    files: {
      "a.ts":
        "export function target(){return 1}\nexport function Zoo(){return target()}\n\n\n\n\n\n\n\nexport function Alpha(){return target()}\n",
    },
  },
  {
    id: "edge-alias-value-position",
    operation: "graph",
    files: {
      "a.ts":
        "export const TOKEN=1,OTHER=2;export function target(...x:unknown[]){return x}\n",
      "b.ts":
        'import {TOKEN as local,OTHER,target} from "./a";\nexport function run(){return target(local,{OTHER,key:local},[OTHER])}\n',
    },
  },
  {
    id: "factory-forward-multiple-originals",
    operation: "graph",
    files: {
      "a.ts":
        "function factory(config:{z:()=>number,a:()=>number}){return ()=>{config.z();return config.a()}}\nconst work=factory({z(){return 1},a(){return 2}});\nexport function invoke(){return work()}\n",
    },
  },
  {
    id: "reference-map-keys-roots-tests",
    operation: "graph",
    files: {
      "a.ts":
        "export function Zoo(){return 1}\nexport function Alpha(){return 2}\nexport class Holder{method(){return Zoo()}}\n",
      "b.ts":
        'import {Zoo,Alpha,Holder} from "./a";\nconst held={Zoo};\nAlpha;\nexport function run(){const callbacks=[Zoo,Alpha];return new Holder()}\n',
      "c.test.ts": 'import {Zoo,Alpha} from "./a";\nZoo;Alpha;\n',
    },
  },
  {
    id: "declared-sibling-guards",
    operation: "graph",
    rules: {
      entryGuardProperties: { zGuard: ["^zGuard$"], aGuard: ["^aGuard$"] },
    },
    files: {
      "a.ts":
        "const pair={zGuard:true,aGuard:true,run(){return 1},other:()=>2};\nexport const api=pair;\n",
    },
  },
  {
    id: "two-package-four-module-workflow",
    operation: "graph",
    files: workflow,
  },
  {
    id: "classify-entry-raw-context",
    operation: "classify",
    extraEvidence: ["�", "\ud800", "\udc00", "é", "é", "2", "10"],
    guards: ["\udc00", "\ud800"],
    rules: { authNames: { auth: ["subject"] } },
    files: { "subject.ts": "export function subject(){return 1}\n" },
  },
  {
    id: "classify-auth-evidence",
    operation: "classify",
    rules: {
      authNames: { z: ["subject"], a: ["subject"] },
      authCallees: { callee: ["authorize"] },
    },
    calls: [
      {
        calleeId: "external:authorize",
        declaration: null,
        line: 1,
        constArgs: [],
      },
    ],
    files: { "subject.ts": "export function subject(){return 1}\n" },
  },
  {
    id: "classify-effect-declaration",
    operation: "classify",
    rules: { effectDeclarations: { z: ["writeRow"], a: ["writeRow"] } },
    calls: [
      {
        calleeId: "external:storage.writeRow",
        declaration: "storage.writeRow",
        line: 1,
        constArgs: [],
      },
    ],
    files: { "subject.ts": "export function subject(){return 1}\n" },
  },
  {
    id: "conventions-raw-and-stable",
    operation: "conventions",
    conventions: Object.fromEntries(
      ["�", "\ud800", "\udc00", "é", "é"].map((n) => [
        n,
        { files: "src/**/*.ts", exports: ["GET", "default"] },
      ]),
    ),
    packagePath: "src/route.ts",
    exportNames: ["GET", "GET", "default"],
  },
  {
    id: "conventions-invalid-first-key",
    operation: "conventions",
    conventions: {
      z: { files: "{z", exports: ["GET"] },
      a: { files: "{a", exports: ["GET"] },
    },
    packagePath: "x.ts",
    exportNames: ["GET"],
  },
  {
    id: "merge-raw-guards-original-map-order",
    operation: "merge",
    maps: [
      { fn: ["�", "\ud800", "é", "é"] },
      { other: ["10", "2"], fn: ["\udc00", "\ud800"] },
    ],
  },
];
cases.push(
  {
    id: "merge-nonlexical-outer-entries",
    operation: "merge-entries",
    maps: [
      { zOwner: ["z", "a"], aOwner: ["a"] },
      { mOwner: ["m"], zOwner: ["b"] },
    ],
  },
  {
    id: "typed-and-base-declaration-guard-facts",
    operation: "graph",
    files: {
      "entry.ts":
        "declare class WorkerEntrypoint<E> {}\nclass Worker extends WorkerEntrypoint<unknown> { public call() {} private hidden() {} protected family() {} static build() {} #secret() {} get value() { return 1; } }\ndeclare const builder: any;\nconst Project = builder.objectRef('Project');\nProject.implement({ authScopes: { user: true }, fields: (t: any) => ({ one: t.field({ resolve: () => 101 }) }) });\nbuilder.objectField(Project, 'more', (t: any) => t.field({ resolve: () => 102 }));\nbuilder.objectField(Project, 'skip', (t: any) => t.field({ skipTypeScopes: true, resolve: () => 103 }));\nconst direct = { authScopes: { user: true }, resolve() { return 104; } };\n",
    },
  },
  {
    id: "next-route-convention-evidence",
    operation: "graph",
    files: {
      "packages/app/package.json": '{"name":"web","dependencies":{"next":"*"}}',
      "packages/app/src/app/api/invoice/route.ts":
        "export function GET(){return 1}\nexport function helper(){return 2}\n",
      "packages/app/src/other.ts": "export function ignored(){return 3}\n",
    },
  },
);
export function filesFor(item) {
  return item.operation === "graph"
    ? { "tsconfig.json": config, ...item.files }
    : (item.files ?? {});
}
