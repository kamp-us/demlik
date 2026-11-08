import fs from "node:fs";
import path from "node:path";
import { loadEdgeProject } from "../../extract/project.js";
import { resolveImports, runtimeSpecifiers } from "../../syntax/imports.js";
import type { BoundaryModule } from "../analyze.js";
import { bindingOwnerIssue, bindingSitesOf } from "../deployables/bindings.js";
import { importsInSourceOrder } from "../deployables/workspaces.js";
import { detectImpureUses } from "../impure-uses.js";
import { interpreterFilesIssue } from "../interpreters/declaration.js";
import { allowanceIssue, importedNamesFor } from "../libraries/allowance.js";
import type { Libraries } from "../libraries/libraries.js";
import { type BoundaryRules, inScope, unlistedPortFolderIssue } from "../rules.js";
import { shapeFactsOf } from "../shape/shape.js";
import { tableFactsOf } from "../tables/tables.js";
import { unknownDriven } from "../zones/reads.js";
import type { Reads } from "./reads.js";

// A scope's files are read when it declares features or is a declared library. A library root has
// none to judge: it holds the packages beneath it that no library names.
function readsFiles(scope: string, rules: BoundaryRules, libraries: Libraries): boolean {
  return rules.features[scope] !== undefined || libraries.typeOfDir.has(scope);
}

function loadModules(scope: string, reads: Reads, repoRoot: string): BoundaryModule[] {
  const scopeAbsolute = scope === "." ? repoRoot : path.join(repoRoot, scope);
  const loaded = loadEdgeProject(scopeAbsolute, "package", repoRoot, reads.listing);
  const { importEdgesByFile } = resolveImports(
    loaded.rootAbsolute,
    loaded.sourceFiles,
    loaded.tsConfigPath,
  );
  return loaded.sourceFiles.map(({ file, syntax }) => {
    const importEdges = importEdgesByFile.get(file) ?? [];
    return {
      file,
      importEdges: reads.deployables.kinds.has("package-import-crosses-deployable")
        ? importsInSourceOrder(syntax, importEdges)
        : importEdges,
      impureUses: detectImpureUses(syntax),
      runtimeSpecifiers: runtimeSpecifiers(syntax),
      importedNames: importedNamesFor(reads.libraries, scope, syntax),
      bindingSites: bindingSitesOf(reads.deployables, inScope(scope, file), syntax),
      tableFacts: tableFactsOf(reads.tables, syntax),
      ...shapeFactsOf(reads.shape, scope, file, syntax),
    };
  });
}

// The names of the entries directly under a scope's `src/`, none when it has no such directory.
function srcEntries(scope: string, repoRoot: string): string[] {
  try {
    return fs.readdirSync(path.join(repoRoot, scope, "src"));
  } catch {
    return [];
  }
}

// The files of one scope with the facts every judgment reads, or an Error saying in one line why the
// scope cannot be read: a folder it leaves unlisted, an owner, an allowance, a root or a driven file
// it names that it does not load.
export function loadScope(
  scope: string,
  rules: BoundaryRules,
  reads: Reads,
  repoRoot: string,
): BoundaryModule[] {
  const listed = rules.features[scope];
  const unlisted =
    listed === undefined
      ? null
      : unlistedPortFolderIssue(scope, listed, srcEntries(scope, repoRoot));
  if (unlisted !== null) throw new Error(unlisted);
  const modules = readsFiles(scope, rules, reads.libraries)
    ? loadModules(scope, reads, repoRoot)
    : [];
  const files = new Set(modules.map((module) => module.file));
  const owners = rules.bindingOwners[scope] ?? {};
  const issue =
    bindingOwnerIssue(scope, owners, files, reads.deployables) ??
    allowanceIssue(reads.libraries, scope, modules) ??
    interpreterFilesIssue(scope, rules.interpreters[scope] ?? {}, files);
  if (issue !== null) throw new Error(issue);
  const unread = unknownDriven(reads.shape.allowance, scope, files);
  if (unread.length > 0) {
    throw new Error(
      `driven file(s) of "readAllowance" in "${scope}" name no file the scope loads: ${unread.join("; ")}. ` +
        "A listed file is an exact scope-relative .ts/.tsx path.",
    );
  }
  return modules;
}
