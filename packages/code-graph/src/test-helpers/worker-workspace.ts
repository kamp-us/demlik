import { SHOP_TSCONFIG } from "./shop-workspace.js";

// A generated workspace of workers for the scale test and the timing script: 14 workers, each a
// hexagonal feature scope of three features, three shared packages, 2,000+ source files, and 115
// planted crossings across the three deployable rules. Everything is a function of the sizes below,
// so two runs of the generator write the same bytes.

const WORKERS = 14;
const FEATURES = ["f0", "f1", "f2"];
const FILES_PER_ZONE = 15;
const PACKAGES = 3;

// The worker call graph: a ring of four, a ring of three, a pair, and the other five workers in two
// one-way chains. A chain is clean; each of the other three components is one B18 entry.
const RINGS = [
  [0, 1, 2, 3],
  [4, 5, 6],
  [7, 8],
];
const CHAINS = [
  [9, 10, 11],
  [12, 13],
];

const pad = (n: number): string => String(n).padStart(2, "0");
const worker = (n: number): string => `w${pad(n)}`;
const dir = (n: number): string => `services/${worker(n)}`;
const lines = (...source: string[]): string => `${source.join("\n")}\n`;

export type WorkerPlanted = readonly [scope: string, kind: string, from: string, target: string];

export type WorkerWorkspace = {
  readonly files: Readonly<Record<string, string>>;
  // The rules file with the three kinds listed, and the same with none of them.
  readonly rules: Readonly<Record<string, unknown>>;
  readonly rulesWithoutDeployables: Readonly<Record<string, unknown>>;
  readonly rulesWith: (kind: string) => Readonly<Record<string, unknown>>;
  readonly planted: readonly WorkerPlanted[];
  readonly sourceFiles: number;
};

type Link = { readonly from: number; readonly to: number };

function links(): Link[] {
  const ring = (members: readonly number[]): Link[] =>
    members.map((from, i) => ({ from, to: members[(i + 1) % members.length] ?? from }));
  const chain = (members: readonly number[]): Link[] =>
    members.slice(0, -1).map((from, i) => ({ from, to: members[i + 1] ?? from }));
  return [...RINGS.flatMap(ring), ...CHAINS.flatMap(chain)];
}

// Every worker declares one binding of each kind B17 judges, and a `LINK` service binding per
// outgoing link of the graph.
function wranglerOf(n: number, all: readonly Link[]): string {
  const outgoing = all.filter((link) => link.from === n);
  return JSON.stringify({
    name: worker(n),
    services: outgoing.map((link) => ({ binding: `LINK${link.to}`, service: worker(link.to) })),
    d1_databases: [{ binding: "DB" }],
    kv_namespaces: [{ binding: "CACHE" }],
    r2_buckets: [{ binding: "ASSETS" }],
    queues: { producers: [{ binding: "EVENTS" }] },
    durable_objects: { bindings: [{ name: "COUNTER", class_name: "Counter" }] },
  });
}

// The clean files of a worker: the zones of every feature, each driven adapter using the database,
// which a driven adapter may.
function cleanFiles(n: number): Record<string, string> {
  const files: Record<string, string> = {};
  for (const feature of FEATURES) {
    const root = `${dir(n)}/src/${feature}`;
    files[`${root}/index.ts`] = `export const ${feature} = 1;\n`;
    files[`${root}/ports.ts`] = "export type Port = unknown;\n";
    for (let i = 0; i < FILES_PER_ZONE; i++) {
      files[`${root}/application/u${i}.ts`] = `export const u${i} = ${i};\n`;
      files[`${root}/adapters/driving/h${i}.ts`] = `export const h${i} = ${i};\n`;
      files[`${root}/adapters/driven/d${i}.ts`] =
        `export const d${i} = (env: Env) => env.DB.prepare("select ${i}");\n`;
    }
  }
  return files;
}

// The six B17 crossings and two B19 crossings planted in a worker, as files and as the rows the run
// must list.
function plantedIn(n: number): { files: Record<string, string>; found: WorkerPlanted[] } {
  const scope = dir(n);
  const [f0, f1, f2] = FEATURES;
  const use = (binding: string, call: string): string =>
    `export const use = (env: Env) => env.${binding}.${call};\n`;
  const binding = (file: string, name: string, call: string): [string, string] => [
    `${scope}/${file}`,
    use(name, call),
  ];
  const planted = [
    binding("src/boot.ts", "ASSETS", 'put("k", "v")'),
    binding(`src/${f0}/application/planted.ts`, "DB", 'prepare("insert")'),
    binding(`src/${f0}/adapters/driving/planted.ts`, "CACHE", 'get("k")'),
    binding(`src/${f1}/index.ts`, "EVENTS", 'send("e")'),
    binding(`src/${f1}/ports.ts`, "COUNTER", 'get("c")'),
    binding("test/e2e.test.ts", "DB", 'prepare("select")'),
  ];
  const shared = (k: number) => `packages/shared-${k % PACKAGES}`;
  const reaches: [string, string, string][] = [
    [`${scope}/src/${f2}/application/reach.ts`, "../../../../../", shared(n)],
    [`${scope}/test/reach.test.ts`, "../../../", shared(n + 1)],
  ];
  const files = Object.fromEntries([
    ...planted,
    ...reaches.map(([file, up, pkg]): [string, string] => [
      file,
      `import { x } from "${up}${pkg}/src/x";\nexport const reach = x;\n`,
    ]),
  ]);
  const found: WorkerPlanted[] = [
    ...planted.map(([file, body]): WorkerPlanted => {
      const name = /env\.([A-Z]+)\./.exec(body)?.[1] ?? "";
      return [scope, "binding-outside-driven-adapter", file, name];
    }),
    ...reaches.map(
      ([file, , pkg]): WorkerPlanted => [scope, "relative-import-crosses-workspace", file, pkg],
    ),
  ];
  return { files, found };
}

function cycleEntries(): WorkerPlanted[] {
  return RINGS.map((members) => {
    const inside = new Set(members);
    const edges = links()
      .filter((link) => inside.has(link.from) && inside.has(link.to))
      .map((link) => `${worker(link.from)}.LINK${link.to} -> ${worker(link.to)}`)
      .sort((a, b) => a.localeCompare(b));
    const names = members.map(worker).sort((a, b) => a.localeCompare(b));
    return [".", "worker-call-cycle", names.join(", "), edges.join("; ")];
  });
}

const KINDS = [
  "binding-outside-driven-adapter",
  "worker-call-cycle",
  "relative-import-crosses-workspace",
];

export function workerWorkspace(): WorkerWorkspace {
  const all = links();
  const sources: Record<string, string> = {};
  const manifests: Record<string, string> = {
    "tsconfig.json": SHOP_TSCONFIG,
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "services/*"\n',
  };
  const found: WorkerPlanted[] = [];
  for (let n = 0; n < WORKERS; n++) {
    manifests[`${dir(n)}/package.json`] = JSON.stringify({ name: `@shop/${worker(n)}` });
    manifests[`${dir(n)}/wrangler.jsonc`] = wranglerOf(n, all);
    Object.assign(sources, cleanFiles(n));
    const planted = plantedIn(n);
    Object.assign(sources, planted.files);
    found.push(...planted.found);
  }
  for (let k = 0; k < PACKAGES; k++) {
    manifests[`packages/shared-${k}/package.json`] = JSON.stringify({ name: `@shop/shared-${k}` });
    sources[`packages/shared-${k}/src/x.ts`] = lines(`export const x = ${k};`);
  }
  const scopes = Array.from({ length: WORKERS }, (_, n) => dir(n));
  const base = {
    features: Object.fromEntries(scopes.map((scope) => [scope, FEATURES])),
    layout: Object.fromEntries(scopes.map((scope) => [scope, "hexagonal"])),
  };
  return {
    files: { ...manifests, ...sources },
    rules: { ...base, acrossDeployables: KINDS },
    rulesWithoutDeployables: base,
    rulesWith: (kind) => ({ ...base, acrossDeployables: [kind] }),
    planted: [...found, ...cycleEntries()],
    sourceFiles: Object.keys(sources).length,
  };
}
