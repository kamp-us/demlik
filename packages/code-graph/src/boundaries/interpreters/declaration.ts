import { GlobSyntaxError, globToRegExp } from "../../kinds/glob.js";
import type { BoundaryRules } from "../rules.js";
import { isPathEntry, pathNames } from "./interpreters.js";

type Technology = BoundaryRules["interpreters"][string][string];

// How a root sits against a folder: it is the folder, holds it, or is inside it. Both are
// scope-relative paths, so a folder is judged by its path and never by its name.
function relation(root: string, folder: string): "is" | "holds" | "sits inside" | null {
  if (root === folder) return "is";
  if (folder.startsWith(`${root}/`)) return "holds";
  if (root.startsWith(`${folder}/`)) return "sits inside";
  return null;
}

function entryOf(scope: string, name: string): string {
  return `technology "${name}" in "${scope}"`;
}

function moduleIssues(scope: string, name: string, { modules }: Technology): string[] {
  if (modules.length === 0) {
    return [
      `"interpreters" ${entryOf(scope, name)} lists no "modules" entry: a technology that covers nothing.`,
    ];
  }
  return modules
    .filter((module) => !isPathEntry(module))
    .flatMap((module) => {
      try {
        globToRegExp(module);
        return [];
      } catch (error) {
        if (!(error instanceof GlobSyntaxError)) throw error;
        return [
          `"interpreters" module "${module}" of ${entryOf(scope, name)} is not a package glob: ${error.message}. An entry that starts with src/ is a scope-relative path.`,
        ];
      }
    });
}

// A root is no feature, and no `lib`: a file under one would be two places at once.
function folderIssues(rules: BoundaryRules, scope: string, name: string, root: string): string[] {
  const kinds = [
    ["feature", rules.features[scope] ?? []],
    ["lib", rules.lib],
  ] as const;
  return kinds.flatMap(([kind, folders]) =>
    folders.flatMap((folder) => {
      const held = relation(root, `src/${folder}`);
      return held === null
        ? []
        : [
            `"interpreters" root "${root}" of ${entryOf(scope, name)} ${held} the ${kind} folder "src/${folder}": an interpreter is no ${kind}, so its root sits in none.`,
          ];
    }),
  );
}

// Two roots of one scope that are, hold or sit inside one another would give a file two technologies.
function rootIssues(scope: string, technologies: Readonly<Record<string, Technology>>): string[] {
  const roots = Object.entries(technologies).map(([name, { root }]) => ({ name, root }));
  return roots.flatMap((a, index) =>
    roots.slice(index + 1).flatMap((b) => {
      const held = relation(a.root, b.root);
      return held === null
        ? []
        : [
            `"interpreters" root "${a.root}" of ${entryOf(scope, a.name)} ${held} the root "${b.root}" of technology "${b.name}": one root per file, so no root holds or sits inside another.`,
          ];
    }),
  );
}

function scopeIssues(rules: BoundaryRules, scope: string): string[] {
  if (rules.features[scope] === undefined) {
    return [
      `"interpreters" declares scope "${scope}", which declares no "features": interpreters ride a scope that declares features.`,
    ];
  }
  const technologies = rules.interpreters[scope] ?? {};
  return [
    ...Object.entries(technologies).flatMap(([name, technology]) => [
      ...moduleIssues(scope, name, technology),
      ...folderIssues(rules, scope, name, technology.root),
    ]),
    ...rootIssues(scope, technologies),
  ];
}

// The first problem in the `interpreters` key that the rules file alone can show, or null. What
// needs the repo (a root or a path module the scope does not load) is judged where the scope is
// loaded.
export function interpreterDeclarationIssue(rules: BoundaryRules): string | null {
  return Object.keys(rules.interpreters).flatMap((scope) => scopeIssues(rules, scope))[0] ?? null;
}

// The first root or path module a scope's `interpreters` names that the scope cannot honour once
// its files are read, or null: a stale or mistyped name would silently turn the check off. `files`
// is every scope-relative file the scope loaded.
export function interpreterFilesIssue(
  scope: string,
  technologies: Readonly<Record<string, Technology>>,
  files: ReadonlySet<string>,
): string | null {
  const loaded = [...files];
  for (const [name, { root, modules }] of Object.entries(technologies)) {
    if (!loaded.some((file) => file.startsWith(`${root}/`))) {
      return `"interpreters" root "${root}" of ${entryOf(scope, name)} holds no source file the scope loads: a root is a scope-relative folder.`;
    }
    for (const module of modules.filter(isPathEntry)) {
      if (!loaded.some((file) => pathNames(module, file))) {
        return `"interpreters" module "${module}" of ${entryOf(scope, name)} names no file or directory the scope loads: a src/ entry is a scope-relative file with its extension dropped, or a folder.`;
      }
    }
  }
  return null;
}
