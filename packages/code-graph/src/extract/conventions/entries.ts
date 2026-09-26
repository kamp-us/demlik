import fs from "node:fs";
import path from "node:path";
import {
  type CompiledConvention,
  compileConventions,
  matchingConventions,
} from "../../kinds/conventions.js";
import { ENTRY_EXPORT_PRESETS, type EntryExportPresetName } from "../../kinds/presets.js";
import type { NodeKindRules } from "../../kinds/rules.js";
import type { DiscoveredFunction } from "../functions.js";
import { exportNamesById } from "./export-names.js";

// The package a file belongs to: the nearest directory at or above it, no higher than the repo
// root, whose package.json exists — or the analyzed root when none does.
type OwningPackage = { readonly dir: string; readonly dependencies: ReadonlySet<string> };

function readDependencies(packageJson: string): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(packageJson, "utf8"));
  } catch {
    return new Set();
  }
  const names = new Set<string>();
  if (typeof parsed !== "object" || parsed === null) return names;
  for (const key of ["dependencies", "devDependencies"] as const) {
    const group = (parsed as Record<string, unknown>)[key];
    if (typeof group === "object" && group !== null) {
      for (const name of Object.keys(group)) names.add(name);
    }
  }
  return names;
}

function packageLocator(
  rootAbsolute: string,
  repoRoot: string,
): (absoluteFile: string) => OwningPackage {
  const byDir = new Map<string, OwningPackage>();
  const fallback: OwningPackage = { dir: rootAbsolute, dependencies: new Set() };
  const owning = (dir: string): OwningPackage => {
    const cached = byDir.get(dir);
    if (cached !== undefined) return cached;
    const manifest = path.join(dir, "package.json");
    const parent = path.dirname(dir);
    const insideRepo = path.relative(repoRoot, dir).startsWith("..") === false;
    let found: OwningPackage;
    if (fs.existsSync(manifest)) found = { dir, dependencies: readDependencies(manifest) };
    else if (dir === repoRoot || parent === dir || !insideRepo) found = fallback;
    else found = owning(parent);
    byDir.set(dir, found);
    return found;
  };
  return (absoluteFile) => owning(path.dirname(absoluteFile));
}

// The conventions in force for one package: the user's own, plus every preset opted into or
// whose framework the package depends on. Compiled once per distinct preset set.
function conventionsFor(
  rules: NodeKindRules,
): (pkg: OwningPackage) => readonly CompiledConvention[] {
  const optedIn = new Set<EntryExportPresetName>(rules.entryExportPresets);
  const user = compileConventions(rules.entryExportConventions);
  const bySet = new Map<string, readonly CompiledConvention[]>();
  return (pkg) => {
    const active = (Object.keys(ENTRY_EXPORT_PRESETS) as EntryExportPresetName[]).filter(
      (name) => optedIn.has(name) || pkg.dependencies.has(ENTRY_EXPORT_PRESETS[name].dependency),
    );
    const key = active.join(",");
    let compiled = bySet.get(key);
    if (compiled === undefined) {
      compiled = [
        ...user,
        ...active.flatMap((name) => compileConventions(ENTRY_EXPORT_PRESETS[name].conventions)),
      ];
      bySet.set(key, compiled);
    }
    return compiled;
  };
}

// Function id → the names of the entrypoint-export conventions that make it an entry.
export function conventionEntries(
  functions: readonly DiscoveredFunction[],
  rules: NodeKindRules,
  rootAbsolute: string,
  repoRoot: string,
): ReadonlyMap<string, readonly string[]> {
  const exportNames = exportNamesById(functions);
  const locate = packageLocator(rootAbsolute, repoRoot);
  const conventions = conventionsFor(rules);
  const out = new Map<string, readonly string[]>();
  for (const fn of functions) {
    const names = exportNames.get(fn.id);
    if (names === undefined || fn.isTest) continue;
    const absolute = path.resolve(rootAbsolute, fn.file);
    const pkg = locate(absolute);
    const packagePath = path.relative(pkg.dir, absolute).split(path.sep).join("/");
    const matched = matchingConventions(conventions(pkg), packagePath, names);
    if (matched.length > 0) out.set(fn.id, matched);
  }
  return out;
}
