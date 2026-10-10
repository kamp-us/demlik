import fs from "node:fs";
import path from "node:path";
import * as ts from "../engine/tsgo.js";
import { findRepoRoot, resolveEdgeTsConfig } from "../extract/project.js";
import { emitDeclarations, emittedEntries, removeEmit } from "./emit.js";
import { ApiInputError, type ApiSubpath, apiSubpaths } from "./map.js";
import { readSubpathNames, type SubpathNames } from "./read.js";

export type PublishedApi = {
  readonly root: string;
  readonly compiler: string;
  readonly subpaths: Readonly<
    Record<
      string,
      { readonly entry: string; readonly tier: string | null; readonly names: SubpathNames }
    >
  >;
};

export type PublishedApiOptions = {
  readonly repoRoot?: string;
  // Where the emit's diagnostic count goes as one warning line; stderr by default.
  readonly warn?: (line: string) => void;
};

export function packageRoot(root: string): string {
  const absolute = path.resolve(root);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new ApiInputError(`${absolute} is not a directory`);
  }
  return fs.realpathSync(absolute);
}

function packageTsConfig(rootAbsolute: string, repoRoot: string): string {
  try {
    return resolveEdgeTsConfig(rootAbsolute, "package", repoRoot);
  } catch (error) {
    throw new ApiInputError(error instanceof Error ? error.message : String(error));
  }
}

function readNames(
  tsConfigPath: string,
  out: string,
  entries: ReadonlyMap<string, string>,
): ReadonlyMap<string, SubpathNames> {
  const program = ts.openTypeProgram({
    tsConfigPath,
    rootFiles: [...new Set(entries.values())].sort(),
    includeConfigFiles: false,
  });
  try {
    return new Map(
      [...entries].map(([subpath, file]) => [subpath, readSubpathNames(program, out, file)]),
    );
  } finally {
    program.close();
  }
}

// What one emit of one tree publishes: the compiler that emitted, and the names per subpath.
export type EmittedNames = {
  readonly compiler: string;
  readonly names: ReadonlyMap<string, SubpathNames>;
};

export const projectRelative = (rootAbsolute: string): string =>
  path.relative(process.cwd(), rootAbsolute) || ".";

// Emits the package at `rootAbsolute` and reads every subpath in `subpaths`, whose entries are
// already checked against that tree. The emit lives in a temp folder outside the tree and is
// removed before this returns or throws. `context` names the tree in the diagnostics warning.
export async function readEmittedNames(
  rootAbsolute: string,
  subpaths: readonly ApiSubpath[],
  options: PublishedApiOptions & { readonly context?: string },
): Promise<EmittedNames> {
  const tsConfigPath = packageTsConfig(
    rootAbsolute,
    options.repoRoot ?? findRepoRoot(rootAbsolute),
  );
  const emit = await emitDeclarations(rootAbsolute, tsConfigPath);
  try {
    if (emit.diagnostics > 0) {
      const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
      warn(
        `code-graph: warning: tsgo reported ${emit.diagnostics} diagnostic(s)${options.context ?? ""}; the declarations were emitted anyway`,
      );
    }
    const entries = emittedEntries(emit, rootAbsolute, subpaths);
    return { compiler: emit.compiler, names: readNames(tsConfigPath, emit.out, entries) };
  } finally {
    removeEmit(emit);
  }
}

// The published-API view of the package at `root` (SPEC §13.3): every name each subpath of `map`
// publishes, with its declaration text as emitted. The emit lives in a temp folder outside the
// checkout and is removed before this returns or throws.
export async function readPublishedApi(
  root: string,
  map: unknown,
  options: PublishedApiOptions = {},
): Promise<PublishedApi> {
  const rootAbsolute = packageRoot(root);
  const subpaths = apiSubpaths(rootAbsolute, map);
  const { compiler, names } = await readEmittedNames(rootAbsolute, subpaths, options);
  const view: Record<string, PublishedApi["subpaths"][string]> = {};
  for (const { subpath, entry, tier } of subpaths) {
    view[subpath] = { entry, tier, names: names.get(subpath) ?? {} };
  }
  return { root: projectRelative(rootAbsolute), compiler, subpaths: view };
}
