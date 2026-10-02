import { SHOP_TSCONFIG } from "./shop-workspace.js";

// A generated workspace of libraries for the scale test and the timing script: 40 libraries
// spread over the five types, three hexagonal feature scopes, and a hundred and ten planted
// crossings across all four library rules. Everything is a function of the sizes below, so two
// runs of the generator write the same bytes.

const TYPES = {
  contract: { imports: ["contract", "util"], pure: true },
  kernel: { imports: ["kernel", "contract", "util"], pure: true },
  util: { imports: ["util"], pure: true },
  adapter: { imports: ["contract", "kernel", "util"], pure: false, importedFrom: ["driven"] },
  ui: { imports: ["ui", "contract", "kernel", "util"], pure: true },
};

type TypeName = keyof typeof TYPES;
const TYPE_NAMES = Object.keys(TYPES) as TypeName[];

// An import of this type is one the importing type forbids, and the generator plants it once per
// library.
const FORBIDDEN: Record<TypeName, TypeName> = {
  contract: "kernel",
  kernel: "ui",
  util: "contract",
  adapter: "adapter",
  ui: "adapter",
};

const PER_TYPE = 8;
const FILES_PER_LIBRARY = 45;
const SCOPES = ["services/s0", "services/s1", "services/s2"];
const FEATURES = ["f0", "f1", "f2", "f3"];
const ZONE_FILES = 8;
const UNDECLARED = 10;
const IMPURE_LIBRARIES = 30;
const OUTSIDE_PER_SCOPE = 10;

const pad = (n: number): string => String(n).padStart(2, "0");
const libDir = (type: TypeName, n: number): string => `packages/${type}-${pad(n)}`;
const importOf = (dir: string): string => `import "@shop/${dir.slice("packages/".length)}";`;

export type Planted = readonly [kind: string, from: string, target: string];

export type LibraryWorkspace = {
  readonly files: Readonly<Record<string, string>>;
  // The rules file with the library keys declared, and the same with none of them.
  readonly rules: Readonly<Record<string, unknown>>;
  readonly rulesWithoutLibraries: Readonly<Record<string, unknown>>;
  readonly planted: readonly Planted[];
  readonly sourceFiles: number;
};

function manifest(dir: string): [string, string] {
  const name = dir.slice(dir.lastIndexOf("/") + 1);
  return [`${dir}/package.json`, JSON.stringify({ name: `@shop/${name}` })];
}

// A library's clean files: each imports a library its type allows, and an adapter uses a world
// library and a world door, which an adapter may.
function libraryFiles(type: TypeName, n: number): Record<string, string> {
  const dir = libDir(type, n);
  const allowed = TYPES[type].imports.filter((t): t is TypeName => t in TYPES && t !== type);
  const files: Record<string, string> = {};
  for (let i = 0; i < FILES_PER_LIBRARY; i++) {
    const target = allowed[i % Math.max(allowed.length, 1)];
    const edge = target === undefined ? "" : `${importOf(libDir(target, (n + i) % PER_TYPE))}\n`;
    const world = type === "adapter" ? 'import "hono";\nexport const at = Date.now();\n' : "";
    files[`${dir}/src/f${pad(i)}.ts`] = `${edge}${world}export const v${i} = ${i};\n`;
  }
  return files;
}

function featureFiles(scope: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const feature of FEATURES) {
    const root = `${scope}/src/${feature}`;
    files[`${root}/index.ts`] = `export const ${feature} = 1;\n`;
    files[`${root}/ports.ts`] = "export type Port = unknown;\n";
    for (let i = 0; i < ZONE_FILES; i++) {
      files[`${root}/application/u${i}.ts`] = `export const u${i} = ${i};\n`;
      files[`${root}/adapters/driving/h${i}.ts`] = `export const h${i} = ${i};\n`;
      files[`${root}/adapters/driven/d${i}.ts`] =
        `${importOf(libDir("adapter", i % PER_TYPE))}\nexport const d${i} = ${i};\n`;
    }
  }
  return files;
}

function planted(): { files: Record<string, string>; found: Planted[] } {
  const files: Record<string, string> = {};
  const found: Planted[] = [];
  for (let n = 0; n < UNDECLARED; n++) {
    const dir = `packages/extra-${pad(n)}`;
    files[`${dir}/src/index.ts`] = "export const extra = 1;\n";
    found.push(["library-undeclared", dir, `extra-${pad(n)}`]);
  }
  for (const type of TYPE_NAMES) {
    for (let n = 0; n < PER_TYPE; n++) {
      const target = libDir(FORBIDDEN[type], type === FORBIDDEN[type] ? (n + 1) % PER_TYPE : n);
      const from = `${libDir(type, n)}/src/up.ts`;
      files[from] = `${importOf(target)}\nexport const up = 1;\n`;
      found.push(["library-imports-up", from, target]);
    }
  }
  const pure = TYPE_NAMES.filter((type) => TYPES[type].pure);
  for (let k = 0; k < IMPURE_LIBRARIES; k++) {
    const type = pure[k % pure.length] ?? "util";
    const from = `${libDir(type, Math.floor(k / pure.length))}/src/impure.ts`;
    const door = k % 2 === 0;
    files[from] = door ? "export const now = Date.now();\n" : 'import "hono";\n';
    found.push(["impure-library", from, door ? "Date.now" : "hono"]);
  }
  SCOPES.forEach((scope, s) => {
    for (let k = 0; k < OUTSIDE_PER_SCOPE; k++) {
      const target = libDir("adapter", (s + k) % PER_TYPE);
      const from = `${scope}/src/boot-${pad(k)}.ts`;
      files[from] = `${importOf(target)}\nexport const boot = ${k};\n`;
      found.push(["adapter-library-imported-outside-driven", from, target]);
    }
  });
  return { files, found };
}

export function libraryWorkspace(): LibraryWorkspace {
  const libraries: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const manifests: Record<string, string> = { "tsconfig.json": SHOP_TSCONFIG };
  for (const type of TYPE_NAMES) {
    for (let n = 0; n < PER_TYPE; n++) {
      libraries[libDir(type, n)] = type;
      Object.assign(sources, libraryFiles(type, n));
    }
  }
  for (const scope of SCOPES) Object.assign(sources, featureFiles(scope));
  const plant = planted();
  Object.assign(sources, plant.files);
  const dirs = [
    ...Object.keys(libraries),
    ...SCOPES,
    ...Array.from({ length: UNDECLARED }, (_, n) => `packages/extra-${pad(n)}`),
  ];
  for (const dir of dirs) Object.assign(manifests, Object.fromEntries([manifest(dir)]));
  const features = Object.fromEntries(SCOPES.map((scope) => [scope, FEATURES]));
  const layout = Object.fromEntries(SCOPES.map((scope) => [scope, "hexagonal"]));
  return {
    files: { ...manifests, ...sources },
    rules: {
      features,
      layout,
      libraryRoots: ["packages"],
      libraryTypes: TYPES,
      libraries,
      worldLibraries: ["drizzle-orm", "hono", "@sentry/*"],
    },
    rulesWithoutLibraries: { features, layout },
    planted: plant.found,
    sourceFiles: Object.keys(sources).length,
  };
}
