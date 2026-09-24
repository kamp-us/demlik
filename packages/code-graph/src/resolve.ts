import path from "node:path";
import { type ExportedDeclarations, type Node, Project, type SourceFile } from "ts-morph";
import { type EdgeScope, resolveEdgeTsConfig } from "./extract/project.js";

export interface ExportOrigin {
  readonly file: string;
  readonly name: string;
}

export interface InProcessGraph {
  resolveExportOrigin(fromFile: string, specifier: string, exportName: string): ExportOrigin | null;
}

export interface InProcessGraphOptions {
  readonly scope?: EdgeScope;
  readonly repoRoot?: string;
}

function declaredName(decl: Node): string | null {
  const named = decl as Node & { getName?: () => string | undefined };
  if (typeof named.getName !== "function") return null;
  return named.getName() ?? null;
}

function originDeclaration(
  target: SourceFile,
  exportName: string,
): ExportedDeclarations | undefined {
  return target.getExportedDeclarations().get(exportName)?.[0];
}

export function loadInProcessGraph(
  root: string,
  options: InProcessGraphOptions = {},
): InProcessGraph | null {
  const rootAbsolute = path.resolve(root);
  const scope: EdgeScope = options.scope ?? "package";
  const repoRoot = options.repoRoot ?? rootAbsolute;

  let tsConfigFilePath: string;
  try {
    tsConfigFilePath = resolveEdgeTsConfig(rootAbsolute, scope, repoRoot);
  } catch {
    return null;
  }

  const project = new Project({
    tsConfigFilePath,
    skipAddingFilesFromTsConfig: true,
    skipLoadingLibFiles: true,
  });

  return {
    resolveExportOrigin(fromFile, specifier, exportName) {
      const absFrom = path.resolve(fromFile);
      const sf = project.getSourceFile(absFrom) ?? project.addSourceFileAtPathIfExists(absFrom);
      if (sf === undefined) return null;

      const imp = sf.getImportDeclarations().find((d) => d.getModuleSpecifierValue() === specifier);
      const target = imp?.getModuleSpecifierSourceFile();
      if (target === undefined) return null;

      const decl = originDeclaration(target, exportName);
      if (decl === undefined) return null;

      return { file: decl.getSourceFile().getFilePath(), name: declaredName(decl) ?? exportName };
    },
  };
}
