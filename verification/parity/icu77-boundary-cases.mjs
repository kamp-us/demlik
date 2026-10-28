const edge = (target, specifier = "./target", typeOnly = false) => ({
  target,
  specifier,
  typeOnly,
  kind: "static",
});
export const moduleInput = (file, edges = [], extra = {}) => ({
  file,
  importEdges: edges,
  offendingForm: null,
  firstWrite: null,
  importedNames: {},
  impureUses: [],
  runtimeSpecifiers: edges.filter((e) => !e.typeOnly).map((e) => e.specifier),
  bindingSites: [],
  ...extra,
});
const scope = "services/api",
  features = { features: { [scope]: ["Z", "a"] } };
const config = (name, services = []) =>
    JSON.stringify({
      name,
      main: "src/main.ts",
      services,
      d1_databases: [{ binding: "DB" }],
    }),
  service = (binding, service) => ({ binding, service });
const catalogFiles = {
  "services/a/wrangler.json": config("Z", [
    service("a", "a"),
    service("self", "Z"),
    service("missing", "outside"),
  ]),
  "services/b/wrangler.json": config("a", [service("Z", "Z")]),
};
const writer = "src/a/adapters/driven/write.ts",
  reader = "src/a/adapters/driven/read.ts",
  driving = "src/a/adapters/driving/http.ts";
export const workflowFiles = {
  "package.json": "{}",
  "rules.json": JSON.stringify({
    features: { "services/api": ["orders"], "services/other": ["billing"] },
    acrossDeployables: ["worker-call-cycle", "binding-outside-driven-adapter"],
    readAllowance: {
      "services/api": { driven: ["src/orders/adapters/driven/store.ts"] },
    },
  }),
  "services/api/wrangler.json": config("api", [service("OTHER", "other")]),
  "services/other/wrangler.json": config("other", [service("API", "api")]),
};
for (const [dir, feature] of [
  ["services/api", "orders"],
  ["services/other", "billing"],
])
  Object.assign(workflowFiles, {
    [`${dir}/package.json`]: "{}",
    [`${dir}/tsconfig.json`]: JSON.stringify({
      compilerOptions: { module: "ESNext", moduleResolution: "Bundler" },
      include: ["src/**/*.ts"],
    }),
    [`${dir}/src/main.ts`]: "export const main=()=>1;",
    [`${dir}/src/${feature}/adapters/driven/store.ts`]:
      "export const read=()=>1;",
    [`${dir}/src/${feature}/application/run.ts`]:
      "import{read}from '../adapters/driven/store';export const run=()=>{fetch('/');return read()};",
    [`${dir}/src/${feature}/adapters/driving/http.ts`]:
      "import{read}from '../driven/store';export const handle=()=>read();",
  });
export const cases = [
  {
    id: "empty-aggregate",
    mode: "analyze",
    rules: {},
    scope: ".",
    modules: [],
  },
  {
    id: "impure-static-raw-paths",
    mode: "impure",
    source:
      'process.Z.a;process.a.Z;process["\\ud800"].x;globalThis.fetch("/");new URL("/");',
  },
  {
    id: "impure-shadow-and-type",
    mode: "impure",
    source:
      'const process={env:{}};process.env.X;type P=typeof fetch;function f(){return fetch("/")}',
  },
  {
    id: "impure-destructure-joined-order",
    mode: "impure",
    source:
      "const {stdin:{isTTY},env:{Z,a}}=process;process.stdin.Z;process.stdin.a;Date.now();Math.random();",
  },
  {
    id: "undeclared-nearest-roots",
    mode: "libraries",
    rules: {
      libraryRoots: ["packages", "packages/nested"],
      libraryTypes: { pure: { pure: true, imports: [] } },
      libraries: { "packages/known": "pure" },
    },
    roots: ["packages", "packages/nested"],
    files: {
      "packages/Z/package.json": '{"name":"Z"}',
      "packages/a/package.json": '{"name":"a"}',
      "packages/known/package.json": '{"name":"known"}',
      "packages/nested/Z/package.json": '{"name":"innerZ"}',
      "packages/nested/a/package.json": '{"name":"innera"}',
    },
  },
  {
    id: "aggregate-three-priorities",
    mode: "analyze",
    scope,
    rules: {
      ...features,
      applicationShape: ["application-import-outside-allowlist"],
    },
    modules: [
      moduleInput("src/Z/application/Z.ts", [
        edge("src/Z/adapters/driven/x.ts", "./Z"),
        edge("src/a/application/a.ts", "../a"),
      ]),
      moduleInput("src/a/application/a.ts", [
        edge("src/a/adapters/driven/x.ts", "./a"),
        edge("src/a/adapters/driven/x.ts", "./Z"),
      ]),
    ],
  },
  {
    id: "feature-and-test-entry-order",
    mode: "analyze",
    scope,
    rules: { ...features, testFiles: ["**/*.test.ts"] },
    modules: [
      moduleInput("src/Z/unknown/Z.ts"),
      moduleInput("src/a/unknown/a.ts"),
      moduleInput("src/a/tests/a.test.ts"),
      moduleInput("src/Z/unknown/Z.ts"),
    ],
  },
  {
    id: "shared-write-original-owner",
    mode: "analyze",
    scope,
    rules: {
      ...features,
      readAllowance: { [scope]: { driven: [writer, reader] } },
    },
    modules: [
      moduleInput(driving, [
        edge(writer, "./write"),
        edge(writer, "./write.js"),
        edge(reader, "./read"),
      ]),
      moduleInput(writer, [], { firstWrite: { binding: "DB", line: 3 } }),
      moduleInput(reader),
    ],
    files: { "services/api/wrangler.json": config("api") },
  },
  {
    id: "application-judged-edge-identity",
    mode: "analyze",
    scope,
    rules: {
      ...features,
      applicationShape: ["application-import-outside-allowlist"],
    },
    modules: [
      moduleInput("src/a/application/a.ts", [
        edge("src/a/adapters/driven/x.ts", "./same"),
        edge("src/a/adapters/driven/x.ts", "./same", true),
        edge(null, "pkg"),
      ]),
    ],
  },
  {
    id: "bindings-sorted-dedup-raw",
    mode: "bindings",
    bindingNames: ["Z", "a", "Z", "\ud800", "\ufffd", "2", "10"],
    owners: {},
  },
  {
    id: "binding-owner-inherited-refusal",
    mode: "bindings",
    bindingNames: ["toString", "constructor", "caller"],
    owners: {},
    driven: true,
  },
  {
    id: "binding-main-and-owned",
    mode: "bindings",
    bindingNames: ["DB", "Z", "a"],
    owners: { DB: ["src/ok.ts"], Z: ["src/ok.ts"] },
    driven: true,
    isMain: true,
  },
  {
    id: "deployables-disabled",
    mode: "read",
    rules: {},
    files: { "bad/wrangler.json": "{" },
  },
  {
    id: "deployables-unparsed-refusal",
    mode: "read",
    rules: {
      acrossDeployables: [
        "worker-call-cycle",
        "relative-import-crosses-workspace",
      ],
    },
    files: { "bad/wrangler.json": "{" },
  },
  {
    id: "worker-service-self-unknown",
    mode: "worker",
    files: {
      ...catalogFiles,
      "services/c/wrangler.json": JSON.stringify({
        name: "\ud800",
        durable_objects: {
          bindings: [{ name: "DO", class_name: "C", script_name: "a" }],
        },
        workflows: [{ binding: "FLOW", class_name: "C", script_name: "a" }],
      }),
    },
  },
  {
    id: "worker-ring-chord-component",
    mode: "worker",
    files: {
      "a/wrangler.json": config("Z", [service("a", "a"), service("m", "m")]),
      "b/wrangler.json": config("a", [service("m", "m")]),
      "c/wrangler.json": config("m", [service("Z", "Z")]),
    },
  },
  {
    id: "worker-multiple-unicode-components",
    mode: "worker",
    files: {
      "a/wrangler.json": config("Z", [service("a", "a")]),
      "b/wrangler.json": config("a", [service("Z", "Z")]),
      "c/wrangler.json": config("\ud800", [service("\ue000", "\ue000")]),
      "d/wrangler.json": config("\ue000", [service("\ud800", "\ud800")]),
    },
  },
  {
    id: "gate-mode-admission-no-write",
    mode: "gate",
    rules: {},
    flags: { acceptCrossings: true },
    files: { "rules.json": "{}", "boundary-ledger.json": "kept" },
  },
  { id: "two-scope-real-workflow", mode: "workflow", files: workflowFiles },
  {
    id: "deployables-workspace-after-graph",
    mode: "read",
    rules: { acrossDeployables: ["relative-import-crosses-workspace"] },
    files: {
      ...catalogFiles,
      "package.json": "{}",
      "packages/Z/package.json": '{"name":"Z"}',
      "packages/a/package.json": '{"name":"a"}',
    },
  },
];
export const filesFor = (item) => item.files ?? {};
