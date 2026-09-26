import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Node, SourceFile } from "@typescript/native-preview/unstable/ast";
import {
  API,
  type Project,
  type Snapshot,
  SymbolFlags,
  type Symbol as TsSymbol,
} from "@typescript/native-preview/unstable/sync";

// The one module that imports @typescript/native-preview. Its API is `unstable/*` and pinned to an
// exact dev build, so everything that reads the checker goes through here; the AST vocabulary is
// re-exported for the passes that walk tsgo's tree.
export * from "@typescript/native-preview/unstable/ast";
export type { TsSymbol };

export type TypeProgram = {
  readonly sourceFile: (absolutePath: string) => SourceFile | undefined;
  readonly symbolAt: (node: Node) => TsSymbol | undefined;
  readonly symbolsAt: (nodes: readonly Node[]) => readonly (TsSymbol | undefined)[];
  readonly aliasTarget: (symbol: TsSymbol) => TsSymbol | undefined;
  readonly declarations: (symbol: TsSymbol) => readonly Node[];
  readonly exportsOf: (moduleSymbol: TsSymbol) => ReadonlyMap<string, TsSymbol>;
  readonly libraryKind: (sourceFile: SourceFile) => LibraryKind | null;
  readonly close: () => void;
};

// A default-library file is a root when the program named it (`compilerOptions.lib`, or the
// target's own default lib when `lib` is unset) and referenced when a root pulled it in through
// `/// <reference lib>`. TypeScript's program lists the referenced ones before every other file
// and the roots after them.
export type LibraryKind = "root" | "referenced";

const DEFAULT_LIB_FOR_TARGET = /^lib\.(d|es6|[a-z0-9]+\.full\.d)\.ts$/;

function rootLibraries(program: Project["program"]): ReadonlySet<string> {
  const named = (program.getCompilerOptions() as { lib?: readonly string[] }).lib;
  if (named !== undefined) return new Set(named.map((name) => name.toLowerCase()));
  const defaults = program
    .getSourceFileNames()
    .map((file) => path.basename(file).toLowerCase())
    .filter((name) => DEFAULT_LIB_FOR_TARGET.test(name));
  return new Set(defaults);
}

export type TypeProgramInput = {
  readonly tsConfigPath: string;
  readonly rootFiles: readonly string[];
  readonly includeConfigFiles: boolean;
};

function virtualConfigPath(tsConfigPath: string, ordinal: number): string {
  return path.join(
    path.dirname(tsConfigPath),
    `.code-graph-${process.pid}-${ordinal}.tsconfig.json`,
  );
}

type OpenedProject = { readonly project: Project; readonly snapshot: Snapshot };

function openProject(
  api: API,
  input: TypeProgramInput,
  configPath: string,
  virtualFiles: Map<string, string>,
): OpenedProject {
  const own = input.includeConfigFiles ? api.parseConfigFile(input.tsConfigPath).fileNames : [];
  const files = [...new Set([...own, ...input.rootFiles])].sort();
  const body = JSON.stringify({ extends: input.tsConfigPath, files, include: [] });
  virtualFiles.set(configPath, body);
  const snapshot = api.updateSnapshot({ openProjects: [configPath] });
  const project = snapshot.getProject(configPath);
  if (project === undefined) {
    snapshot.dispose();
    throw new Error(`code-graph: tsgo opened no project for ${configPath}`);
  }
  return { project, snapshot };
}

// One tsgo process that opens many programs over one tsconfig. Each program is its own project, so
// it answers exactly what a fresh `openTypeProgram` over the same roots answers; closing it releases
// that project and keeps the process; closing the session ends it.
export type TypeSession = {
  readonly program: (input: SessionProgramInput) => TypeProgram;
  readonly close: () => void;
};

export type SessionProgramInput = Omit<TypeProgramInput, "tsConfigPath">;

export function openTypeSession(tsConfigPath: string): TypeSession {
  const virtualFiles = new Map<string, string>();
  const api = new API({
    cwd: path.dirname(tsConfigPath),
    fs: { readFile: (fileName) => virtualFiles.get(fileName) },
  });
  let opened = 0;
  return {
    program: (input) => {
      const configPath = virtualConfigPath(tsConfigPath, opened++);
      const { project, snapshot } = openProject(
        api,
        { tsConfigPath, ...input },
        configPath,
        virtualFiles,
      );
      return typeProgramOf(project, () => {
        snapshot.dispose();
        api.updateSnapshot({ closeProjects: [configPath] }).dispose();
        virtualFiles.delete(configPath);
      });
    },
    close: () => api.close(),
  };
}

export function openTypeProgram(input: TypeProgramInput): TypeProgram {
  const session = openTypeSession(input.tsConfigPath);
  try {
    return { ...session.program(input), close: session.close };
  } catch (error) {
    session.close();
    throw error;
  }
}

function typeProgramOf(project: Project, close: () => void): TypeProgram {
  const { checker, program } = project;
  const roots = rootLibraries(program);
  const declarationCache = new Map<TsSymbol, readonly Node[]>();

  const declarations = (symbol: TsSymbol): readonly Node[] => {
    const cached = declarationCache.get(symbol);
    if (cached !== undefined) return cached;
    const nodes = symbol.declarations
      .map((handle) => handle.resolve(project))
      .filter((node): node is Node => node !== undefined);
    declarationCache.set(symbol, nodes);
    return nodes;
  };

  return {
    sourceFile: (absolutePath) => program.getSourceFile(absolutePath),
    symbolAt: (node) => checker.getSymbolAtLocation(node),
    symbolsAt: (nodes) => (nodes.length === 0 ? [] : checker.getSymbolAtLocation(nodes)),
    aliasTarget: (symbol) =>
      (symbol.flags & SymbolFlags.Alias) === 0 ? undefined : checker.getAliasedSymbol(symbol),
    declarations,
    exportsOf: (moduleSymbol) => {
      const out = new Map<string, TsSymbol>();
      for (const symbol of checker.getExportsOfModule(moduleSymbol)) out.set(symbol.name, symbol);
      return out;
    },
    libraryKind: (sourceFile) => {
      if (!program.isSourceFileDefaultLibrary(sourceFile)) return null;
      return roots.has(path.basename(sourceFile.fileName).toLowerCase()) ? "root" : "referenced";
    },
    close,
  };
}

export type TsgoBinary = { readonly path: string; readonly version: string };

// The `tsgo` executable this pin ships, for a caller that runs the compiler itself (the bench's
// full-check row) rather than through the API.
export async function tsgoBinary(): Promise<TsgoBinary> {
  const manifest = createRequire(import.meta.url).resolve(
    "@typescript/native-preview/package.json",
  );
  const root = path.dirname(manifest);
  const exe = (await import(pathToFileURL(path.join(root, "lib", "getExePath.js")).href)) as {
    default: () => string;
  };
  const version = (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version: string }).version;
  return { path: exe.default(), version };
}
