import fs from "node:fs";
import path from "node:path";
import * as ts from "../engine/tsgo.js";
import { findRepoRoot, resolveEdgeTsConfig } from "../extract/project.js";
import { EmittedTree, emitDeclarations, emittedEntries, removeEmit } from "./emit.js";
import { ApiInputError, type ApiSubpath, apiSubpaths } from "./map.js";
import {
  blankNames,
  readSubpathNames,
  type SubpathNames,
  type UnresolvedSpecifier,
  unresolvedSpecifiers,
} from "./read.js";

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
  // Where the emit's diagnostic count, each specifier the read could not resolve and each published
  // name with no text go, one warning line each; stderr by default.
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

type ReadNames = {
  readonly names: ReadonlyMap<string, SubpathNames>;
  readonly unresolved: readonly UnresolvedSpecifier[];
};

// The program holds every file the compile held, so an ambient module in a source `.d.ts` is there
// too; only the files that emitted read differently.
function readNames(
  tsConfigPath: string,
  tree: EmittedTree,
  entries: ReadonlyMap<string, string>,
): ReadNames {
  const entryFiles = [...new Set(entries.values())].sort();
  const program = ts.openTypeProgram({
    tsConfigPath,
    rootFiles: entryFiles,
    includeConfigFiles: true,
    textOverlay: tree.textOf,
  });
  try {
    return {
      names: new Map(
        [...entries].map(([subpath, file]) => [subpath, readSubpathNames(program, tree, file)]),
      ),
      unresolved: unresolvedSpecifiers(program, tree, entryFiles),
    };
  } finally {
    program.close();
  }
}

// What one emit of one tree publishes: the compiler that emitted, how many diagnostics the emit and
// the read counted between them, and the names per subpath.
export type EmittedNames = {
  readonly compiler: string;
  readonly diagnostics: number;
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
    const warn = options.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
    const context = options.context ?? "";
    if (emit.diagnostics > 0) {
      warn(
        `code-graph: warning: tsgo reported ${emit.diagnostics} diagnostic(s)${context}; the declarations were emitted anyway`,
      );
    }
    const tree = new EmittedTree(emit, rootAbsolute);
    const { names, unresolved } = readNames(tsConfigPath, tree, emittedEntries(tree, subpaths));
    for (const { specifier, file } of unresolved) {
      warn(
        `code-graph: warning: ${file} names "${specifier}", which the read could not resolve${context}; any name behind it is missing or has no text`,
      );
    }
    // A blank name on a run that already warned has its explanation: a syntax error reads this way.
    const explained = emit.diagnostics + unresolved.length > 0;
    const blank = explained ? [] : blankNames(names);
    for (const { subpath, name } of blank) {
      warn(
        `code-graph: warning: ${subpath} publishes "${name}", which the read found no text for${context}; a module behind it may not resolve`,
      );
    }
    return {
      compiler: emit.compiler,
      diagnostics: emit.diagnostics + unresolved.length + blank.length,
      names,
    };
  } finally {
    removeEmit(emit);
  }
}

// The view beside the count of diagnostics its emit and read reported. The count stays out of
// `PublishedApi` because `--api` prints that object as it is.
export type MeasuredApi = { readonly view: PublishedApi; readonly diagnostics: number };

export async function readMeasuredApi(
  root: string,
  map: unknown,
  options: PublishedApiOptions = {},
): Promise<MeasuredApi> {
  const rootAbsolute = packageRoot(root);
  const subpaths = apiSubpaths(rootAbsolute, map);
  const { compiler, diagnostics, names } = await readEmittedNames(rootAbsolute, subpaths, options);
  const view: Record<string, PublishedApi["subpaths"][string]> = {};
  for (const { subpath, entry, tier } of subpaths) {
    view[subpath] = { entry, tier, names: names.get(subpath) ?? {} };
  }
  return {
    view: { root: projectRelative(rootAbsolute), compiler, subpaths: view },
    diagnostics,
  };
}

// The published-API view of the package at `root` (SPEC §13.3): every name each subpath of `map`
// publishes, with its declaration text as emitted. The emit lives in a temp folder outside the
// checkout and is removed before this returns or throws.
export async function readPublishedApi(
  root: string,
  map: unknown,
  options: PublishedApiOptions = {},
): Promise<PublishedApi> {
  return (await readMeasuredApi(root, map, options)).view;
}
