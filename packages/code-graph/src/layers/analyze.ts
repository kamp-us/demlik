import path from "node:path";
import { discoverPackageRoots, type LoadedProject, type SourceUnit } from "../extract/project.js";
import { importLiterals } from "../syntax/imports.js";
import { compileMatchers, directionOf, layerOf } from "./classify.js";
import { type ResolvedTarget, resolveTarget, workspacePackages } from "./resolve-target.js";
import type { LayerRules } from "./rules.js";

export type LayerEdge = {
  readonly from: string;
  readonly fromLine: number;
  readonly fromLayer: string;
  readonly to: string;
  readonly toLine: number;
  readonly toLayer: string;
  readonly specifier: string;
  readonly typeOnly: boolean;
};

export type LayerCensus = {
  down: number;
  sideways: number;
  up: number;
  unlayered: number;
  external: number;
  unresolved: number;
};

export type LayerReport = {
  readonly layers: readonly string[];
  readonly filesScanned: number;
  readonly census: LayerCensus;
  readonly violations: readonly LayerEdge[];
  readonly unresolved: readonly string[];
};

type Specifier = {
  readonly value: string;
  readonly line: number;
  readonly typeOnly: boolean;
};

// A specifier is type-only when its own `import type` / `export type … from` says so; a dynamic
// `import()` or `typeof import()` never is.
function specifiersOf(unit: SourceUnit): Specifier[] {
  return importLiterals(unit.syntax).map((literal) => ({
    value: literal.specifier,
    line: unit.syntax.lineOf(literal.start),
    typeOnly: literal.typeOnly,
  }));
}

function locate(target: ResolvedTarget): { file: string; line: number } | null {
  switch (target.kind) {
    case "file":
      return { file: target.file, line: 1 };
    case "package":
      return { file: target.pkg.entry ?? target.pkg.dir, line: 1 };
    case "external":
    case "unresolved":
      return null;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

function sortEdges(edges: LayerEdge[]): LayerEdge[] {
  return edges.sort(
    (a, b) => a.from.localeCompare(b.from) || a.fromLine - b.fromLine || a.to.localeCompare(b.to),
  );
}

export function analyzeLayers(
  loaded: LoadedProject,
  repoRoot: string,
  rules: LayerRules,
): LayerReport {
  const matchers = compileMatchers(rules.layers);
  const packages = workspacePackages(repoRoot, discoverPackageRoots(repoRoot));
  const census: LayerCensus = {
    down: 0,
    sideways: 0,
    up: 0,
    unlayered: 0,
    external: 0,
    unresolved: 0,
  };
  const violations: LayerEdge[] = [];
  const unresolved: string[] = [];

  for (const unit of loaded.sourceFiles) {
    const from = path.relative(repoRoot, unit.absolutePath).split(path.sep).join("/");
    const fromLayer = layerOf(from, matchers);
    for (const spec of specifiersOf(unit)) {
      const target = resolveTarget(repoRoot, from, spec.value, packages);
      if (target.kind === "external") {
        census.external++;
        continue;
      }
      if (target.kind === "unresolved") {
        census.unresolved++;
        unresolved.push(`${from}:${spec.line} ${target.specifier}`);
        continue;
      }
      const at = locate(target);
      if (at === null) continue;
      const toLayer = layerOf(at.file, matchers);
      const { direction } = directionOf(fromLayer, toLayer);
      census[direction]++;
      if (direction !== "up" || fromLayer === null || toLayer === null) continue;
      violations.push({
        from,
        fromLine: spec.line,
        fromLayer: fromLayer.name,
        to: at.file,
        toLine: at.line,
        toLayer: toLayer.name,
        specifier: spec.value,
        typeOnly: spec.typeOnly,
      });
    }
  }

  return {
    layers: rules.layers.map((l) => l.name),
    filesScanned: loaded.sourceFiles.length,
    census,
    violations: sortEdges(violations),
    unresolved: unresolved.sort((a, b) => a.localeCompare(b)),
  };
}
