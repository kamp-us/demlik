import { SHOP_TSCONFIG, SHOP_TYPES } from "./shop-workspace.js";

// A generated workspace for the shape rules' scale test and timing script: three hexagonal scopes of
// eight features, 40 libraries over the five types, 2,000+ source files of which 300+ are tests that
// carry code that would be a B6, B7, B10 or B13 crossing outside the test role, and 100+ planted
// crossings across B8, B9, B15 and B16. Everything is a function of the sizes below, so two runs of
// the generator write the same bytes.

const SCOPES = ["services/s0", "services/s1", "services/s2"];
const FEATURES = ["f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7"];
const FILES_PER_ZONE = 10;
const PER_TYPE = 8;
const FILES_PER_LIBRARY = 25;
const TYPES = Object.keys(SHOP_TYPES);
// Libraries that plant a B15 in their entry file.
const DECLARING_LIBRARIES = 10;
// Features per scope whose entry file plants a B15, each with one of the four forms.
const OFFENDING_ENTRIES = 4;
// Features per scope that plant a second B16.
const HONO_FEATURES = 4;

const pad = (n: number): string => String(n).padStart(2, "0");
const libDir = (type: string, n: number): string => `packages/${type}-${pad(n)}`;
const importOf = (dir: string): string => `@shop/${dir.slice("packages/".length)}`;
const lines = (...source: string[]): string => `${source.join("\n")}\n`;

export type ShapePlanted = readonly [scope: string, kind: string, from: string, target: string];

export type ShapeWorkspace = {
  readonly files: Readonly<Record<string, string>>;
  // The rules file with every new key declared, and the same with none of them.
  readonly rules: Readonly<Record<string, unknown>>;
  readonly rulesWithoutShape: Readonly<Record<string, unknown>>;
  // The rules file with the keys of one group declared, and the names of the groups: what the timing
  // script measures one at a time.
  readonly rulesWith: (group: string) => Readonly<Record<string, unknown>>;
  readonly groups: readonly string[];
  readonly planted: readonly ShapePlanted[];
  readonly sourceFiles: number;
  readonly testFiles: number;
};

const SHAPE_KINDS = ["index-not-exports-only", "application-import-outside-allowlist"];
const OFFENDING_FORMS = [
  { body: (u: string) => `export * from "./application/${u}";\n`, form: "export *" },
  {
    body: (u: string) => `export { ${u} } from "./application/${u}";\nexport default {};\n`,
    form: "export default",
  },
  { body: () => "export const version = 1;\n", form: "declaration" },
  {
    body: (u: string) => `import { ${u} } from "./application/${u}";\nexport { ${u} };\n`,
    form: "import",
  },
];

// A library: named re-exports in its entry file, and in each one a test that reads the clock, which
// a pure library may not do outside the test role.
function libraryFiles(type: string, n: number, declares: boolean): Record<string, string> {
  const dir = libDir(type, n);
  const files: Record<string, string> = {
    [`${dir}/package.json`]: JSON.stringify({ name: `@shop/${dir.slice("packages/".length)}` }),
    [`${dir}/src/clock.test.ts`]: "export const stamp = Date.now();\n",
    [`${dir}/src/clock2.test.ts`]: "export const later = Date.now();\n",
  };
  const members = Array.from({ length: FILES_PER_LIBRARY - 3 }, (_, i) => `v${pad(i)}`);
  for (const member of members) {
    files[`${dir}/src/${member}.ts`] = `export const ${member} = ${member.length};\n`;
  }
  files[`${dir}/src/index.ts`] = declares
    ? "export function declared() {\n  return 1;\n}\n"
    : lines(...members.map((member) => `export { ${member} } from "./${member}";`));
  return files;
}

// The clean files of a feature: the zones with their ten files each, and the files that must stay
// clean on purpose: a read through a listed driven file beside a `kernel` library.
function cleanFeature(scope: string, feature: string, f: number): Record<string, string> {
  const root = `${scope}/src/${feature}`;
  const files: Record<string, string> = {
    [`${root}/ports.ts`]: "export type Port = unknown;\n",
  };
  for (let i = 0; i < FILES_PER_ZONE; i++) {
    files[`${root}/application/u${i}.ts`] = lines(
      'import { z } from "zod";',
      'import type { Port } from "../ports";',
      `import { v00 } from "${importOf(libDir("contract", i % PER_TYPE))}";`,
      `export const u${i} = [z, v00] as unknown as Port;`,
    );
    files[`${root}/adapters/driving/h${i}.ts`] = `export const h${i} = ${i};\n`;
    files[`${root}/adapters/driven/d${i}.ts`] =
      `export const d${i} = (env: Env) => env.DB.prepare("select ${i}");\n`;
  }
  if (f === 0) {
    files[`${root}/adapters/driven/reads.ts`] =
      'export const read = (env: Env) => env.DB.prepare("select id from t");\n';
    files[`${root}/adapters/driving/reader.ts`] = lines(
      `import { v00 } from "${importOf(libDir("kernel", 0))}";`,
      'import { read } from "../driven/reads";',
      "export const reader = [v00, read];",
    );
  }
  if (f === 1) {
    files[`${root}/adapters/driven/writes.ts`] =
      'export const write = (env: Env) => env.DB.prepare("update t set a = 1");\n';
  }
  return files;
}

// Ten tests per feature, each carrying code that is a crossing anywhere else: four in `application/`
// (B6 and B7), three in `adapters/driving/` (B8 and B9) and three at the feature root (B10).
function featureTests(scope: string, feature: string): Record<string, string> {
  const root = `${scope}/src/${feature}`;
  const files: Record<string, string> = {};
  for (let i = 0; i < 4; i++) {
    files[`${root}/application/t${i}.test.ts`] = lines(
      `import { d${i} } from "../adapters/driven/d${i}";`,
      `export const t${i} = [Date.now(), d${i}];`,
    );
  }
  for (let i = 0; i < 3; i++) {
    files[`${root}/adapters/driving/t${i}.test.ts`] = lines(
      `import { u${i} } from "../../application/u${i}";`,
      `export const t${i} = () => console.log(u${i});`,
    );
    files[`${root}/root${i}.test.ts`] = `export const root${i} = ${i};\n`;
  }
  return files;
}

type Planted = { files: Record<string, string>; found: ShapePlanted[] };

function plantedIn(scope: string, feature: string, f: number): Planted {
  const root = `${scope}/src/${feature}`;
  const files: Record<string, string> = {};
  const found: ShapePlanted[] = [];
  const plant = (kind: string, file: string, body: string, target: string) => {
    files[file] = body;
    found.push([scope, kind, file, target]);
  };
  const B16 = "application-import-outside-allowlist";
  plant(
    B16,
    `${root}/application/planted.ts`,
    'import { drizzle } from "drizzle-orm";\nexport const orm = drizzle;\n',
    "drizzle-orm",
  );
  if (f < HONO_FEATURES) {
    plant(
      B16,
      `${root}/application/planted2.ts`,
      'import { Hono } from "hono";\nexport const app = Hono;\n',
      "hono",
    );
  }
  plant(
    "driving-reaches-driven",
    `${root}/adapters/driving/planted.ts`,
    'import { d0 } from "../driven/d0";\nexport const reach = d0;\n',
    `${root}/adapters/driven/d0.ts`,
  );
  plant(
    "door-outside-driven-adapter",
    `${root}/adapters/driving/log.ts`,
    'export const log = () => console.log("driving");\n',
    "console",
  );
  if (f === 1) {
    plant(
      "driving-reaches-driven",
      `${root}/adapters/driving/writer.ts`,
      lines(
        `import { v00 } from "${importOf(libDir("kernel", 0))}";`,
        'import { write } from "../driven/writes";',
        "export const writer = [v00, write];",
      ),
      `${root}/adapters/driven/writes.ts`,
    );
  }
  return { files, found };
}

// What one part of the workspace writes: source files, manifests, and the crossings it plants.
type Written = {
  readonly sources: Record<string, string>;
  readonly manifests: Record<string, string>;
  readonly found: ShapePlanted[];
};

const emptyWritten = (): Written => ({ sources: {}, manifests: {}, found: [] });

// The 40 libraries, and which type each is. The first ten declare something in their entry file.
function librariesOf(): Written & { readonly types: Record<string, string> } {
  const written = { ...emptyWritten(), types: {} as Record<string, string> };
  let declaring = 0;
  for (const type of TYPES) {
    for (let n = 0; n < PER_TYPE; n++) {
      const dir = libDir(type, n);
      const declares = declaring < DECLARING_LIBRARIES;
      declaring += declares ? 1 : 0;
      written.types[dir] = type;
      for (const [file, body] of Object.entries(libraryFiles(type, n, declares))) {
        (file.endsWith("package.json") ? written.manifests : written.sources)[file] = body;
      }
      if (declares) {
        written.found.push([dir, "index-not-exports-only", `${dir}/src/index.ts`, "declaration"]);
      }
    }
  }
  return written;
}

// A feature's entry file: named re-exports, or one of the four forms that break that, and the
// crossing the form is.
function entryOf(scope: string, feature: string, f: number): Written {
  const file = `${scope}/src/${feature}/index.ts`;
  const offender = f < OFFENDING_ENTRIES ? OFFENDING_FORMS[f] : undefined;
  if (offender === undefined) {
    return { ...emptyWritten(), sources: { [file]: 'export { u0 } from "./application/u0";\n' } };
  }
  return {
    ...emptyWritten(),
    sources: { [file]: offender.body("u0") },
    found: [[scope, "index-not-exports-only", file, offender.form]],
  };
}

// One hexagonal scope: its manifests, and each feature's clean files, tests, entry file and crossings.
function scopeOf(scope: string, s: number): Written {
  const written = emptyWritten();
  written.manifests[`${scope}/package.json`] = JSON.stringify({ name: `@shop/s${s}` });
  written.manifests[`${scope}/wrangler.jsonc`] = JSON.stringify({
    name: `s${s}`,
    d1_databases: [{ binding: "DB" }],
  });
  FEATURES.forEach((feature, f) => {
    const entry = entryOf(scope, feature, f);
    const planted = plantedIn(scope, feature, f);
    Object.assign(
      written.sources,
      cleanFeature(scope, feature, f),
      featureTests(scope, feature),
      entry.sources,
      planted.files,
    );
    written.found.push(...entry.found, ...planted.found);
  });
  return written;
}

// The six keys, by name.
function keysOf(): Record<string, unknown> {
  const allowance = {
    driven: ["src/f0/adapters/driven/reads.ts", "src/f1/adapters/driven/writes.ts"],
    decidedBy: ["kernel"],
  };
  return {
    applicationShape: SHAPE_KINDS,
    applicationMayImport: ["contract", "kernel", "util"],
    pureDependencies: ["zod"],
    testFiles: ["**/*.test.ts"],
    strictDriving: SCOPES,
    readAllowance: Object.fromEntries(SCOPES.map((scope) => [scope, allowance])),
  };
}

// The groups of keys the timing script declares one at a time: B15 and B16 with the keys that
// narrow B16, and each of the other three keys alone.
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  "application shape": ["applicationShape", "applicationMayImport", "pureDependencies"],
  "test files": ["testFiles"],
  "strict doors": ["strictDriving"],
  "read allowance": ["readAllowance"],
};

export function shapeWorkspace(): ShapeWorkspace {
  const libraries = librariesOf();
  const parts = [libraries, ...SCOPES.map((scope, s) => scopeOf(scope, s))];
  const sources: Record<string, string> = Object.assign({}, ...parts.map((part) => part.sources));
  const manifests: Record<string, string> = Object.assign(
    {
      "tsconfig.json": SHOP_TSCONFIG,
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "services/*"\n',
    },
    ...parts.map((part) => part.manifests),
  );
  const base = {
    features: Object.fromEntries(SCOPES.map((scope) => [scope, FEATURES])),
    layout: Object.fromEntries(SCOPES.map((scope) => [scope, "hexagonal"])),
    libraryRoots: ["packages"],
    libraryTypes: SHOP_TYPES,
    libraries: libraries.types,
    worldLibraries: ["drizzle-orm", "hono", "@sentry/*"],
  };
  const keys = keysOf();
  const names = Object.keys(sources);
  return {
    files: { ...manifests, ...sources },
    rules: { ...base, ...keys },
    rulesWithoutShape: base,
    rulesWith: (group) => ({
      ...base,
      ...Object.fromEntries((GROUPS[group] ?? []).map((key) => [key, keys[key]])),
    }),
    groups: Object.keys(GROUPS),
    planted: parts.flatMap((part) => part.found),
    sourceFiles: names.length,
    testFiles: names.filter((file) => file.endsWith(".test.ts")).length,
  };
}
