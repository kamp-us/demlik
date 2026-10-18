import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, posix } from "node:path";
import { z } from "zod";
import {
  packageLabel,
  type Workspace,
  type WorkspacePackage,
} from "./workspace.js";

/** An import across a package line: the package the importer sits in, and the package it imports. */
export type PackageEdge = {
  readonly from: WorkspacePackage;
  readonly to: WorkspacePackage;
};

/** One `package.json` gaining `workspace:*` dependencies: which package, the names, its new text. */
export type ManifestEdit = {
  readonly pkg: WorkspacePackage;
  /** Repo-relative path of the `package.json`. */
  readonly path: string;
  readonly adds: readonly string[];
  readonly text: string;
};

const FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

const Names = z.record(z.string(), z.string()).optional();
const Declared = z.object({
  dependencies: Names,
  devDependencies: Names,
  peerDependencies: Names,
  optionalDependencies: Names,
});

const manifestPath = (pkg: WorkspacePackage) =>
  posix.join(pkg.root, "package.json");

/** The indent a JSON text is written with, read off its first indented line; two spaces by default. */
const indentOf = (text: string): string =>
  /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";

/**
 * The dependency graph of a pnpm workspace as its `package.json` files declare it: for each package,
 * the workspace packages it names in any dependency field. Read once, before anything is written.
 */
export class WorkspaceDependencies {
  readonly #byName: ReadonlyMap<string, WorkspacePackage>;
  readonly #declared: ReadonlyMap<string, ReadonlySet<string>>;
  readonly #texts: ReadonlyMap<string, string>;

  private constructor(
    readonly workspace: Workspace,
    texts: ReadonlyMap<string, string>,
    declared: ReadonlyMap<string, ReadonlySet<string>>,
  ) {
    this.#texts = texts;
    this.#declared = declared;
    const byName = new Map<string, WorkspacePackage>();
    for (const pkg of this.#packages())
      if (pkg.name !== undefined) byName.set(pkg.name, pkg);
    this.#byName = byName;
  }

  static read(repoRoot: string, workspace: Workspace): WorkspaceDependencies {
    const texts = new Map<string, string>();
    const declared = new Map<string, ReadonlySet<string>>();
    for (const pkg of [workspace.root, ...workspace.members]) {
      const path = join(repoRoot, manifestPath(pkg));
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      const parsed = Declared.safeParse(JSON.parse(text));
      if (!parsed.success)
        throw new Error(
          `${manifestPath(pkg)}: unreadable dependencies: ${parsed.error.message}`,
        );
      texts.set(pkg.root, text);
      declared.set(
        pkg.root,
        new Set(FIELDS.flatMap((f) => Object.keys(parsed.data[f] ?? {}))),
      );
    }
    return new WorkspaceDependencies(workspace, texts, declared);
  }

  #packages(): WorkspacePackage[] {
    return [this.workspace.root, ...this.workspace.members];
  }

  /** Whether `pkg` already names `name` in one of its dependency fields. */
  declares(pkg: WorkspacePackage, name: string): boolean {
    return this.#declared.get(pkg.root)?.has(name) ?? false;
  }

  /**
   * The edges among `edges` its `package.json` does not declare yet, one per importing package and
   * imported name, ordered by package root then name. An edge to a package with no name has no
   * dependency to write, and the rewrite already refused any import of it.
   */
  undeclared(edges: readonly PackageEdge[]): PackageEdge[] {
    const seen = new Set<string>();
    const out: PackageEdge[] = [];
    for (const edge of edges) {
      const name = edge.to.name;
      if (name === undefined || edge.from.root === edge.to.root) continue;
      const key = `${edge.from.root}\0${name}`;
      if (seen.has(key) || this.declares(edge.from, name)) continue;
      seen.add(key);
      out.push(edge);
    }
    return out.sort(
      (a, b) =>
        a.from.root.localeCompare(b.from.root) ||
        (a.to.name ?? "").localeCompare(b.to.name ?? ""),
    );
  }

  /**
   * Each cycle an added edge closes in the graph the workspace declares plus `added`, as the chain
   * of packages from the edge's importer back round to it. Cycles the workspace already declares,
   * with none of `added` on them, are not this move's to refuse.
   */
  cyclesClosedBy(added: readonly PackageEdge[]): WorkspacePackage[][] {
    const next = new Map<string, WorkspacePackage[]>();
    const link = (from: WorkspacePackage, to: WorkspacePackage) => {
      const list = next.get(from.root) ?? [];
      if (!list.some((p) => p.root === to.root)) list.push(to);
      next.set(from.root, list);
    };
    for (const pkg of this.#packages())
      for (const name of [...(this.#declared.get(pkg.root) ?? [])].sort()) {
        const to = this.#byName.get(name);
        if (to !== undefined && to.root !== pkg.root) link(pkg, to);
      }
    for (const { from, to } of added) link(from, to);

    const cycles: WorkspacePackage[][] = [];
    const named = new Set<string>();
    for (const { from, to } of added) {
      const path = this.#pathBetween(next, to, from);
      if (path === undefined) continue;
      const cycle = [from, ...path];
      const key = cycle
        .slice(0, -1)
        .map((p) => p.root)
        .sort()
        .join("\0");
      if (named.has(key)) continue;
      named.add(key);
      cycles.push(cycle);
    }
    return cycles;
  }

  /** The shortest chain of packages from `start` to `goal` along `next`, both ends included. */
  #pathBetween(
    next: ReadonlyMap<string, readonly WorkspacePackage[]>,
    start: WorkspacePackage,
    goal: WorkspacePackage,
  ): WorkspacePackage[] | undefined {
    const cameFrom = new Map<string, WorkspacePackage | null>([
      [start.root, null],
    ]);
    const queue = [start];
    while (queue.length > 0) {
      const at = queue.shift() as WorkspacePackage;
      if (at.root === goal.root) {
        const path: WorkspacePackage[] = [];
        let step: WorkspacePackage | null = at;
        while (step !== null) {
          path.unshift(step);
          step = cameFrom.get(step.root) ?? null;
        }
        return path;
      }
      for (const to of next.get(at.root) ?? []) {
        if (cameFrom.has(to.root)) continue;
        cameFrom.set(to.root, at);
        queue.push(to);
      }
    }
    return undefined;
  }

  /**
   * The `package.json` texts that declare every edge of `added` as `"<name>": "workspace:*"` in
   * `dependencies`, kept in name order, one edit per importing package. Throws for an importer whose
   * package has no `package.json` to declare it in.
   */
  edits(added: readonly PackageEdge[]): ManifestEdit[] {
    const byPackage = new Map<
      string,
      { pkg: WorkspacePackage; adds: string[] }
    >();
    for (const { from, to } of added) {
      if (to.name === undefined) continue;
      const entry = byPackage.get(from.root) ?? { pkg: from, adds: [] };
      entry.adds.push(to.name);
      byPackage.set(from.root, entry);
    }
    return [...byPackage.values()].map(({ pkg, adds }) => {
      const text = this.#texts.get(pkg.root);
      if (text === undefined)
        throw new Error(
          `${packageLabel(pkg)} has no package.json to declare ${adds.join(", ")} in; refusing before any commit`,
        );
      const json = JSON.parse(text) as Record<string, unknown>;
      const current = (json.dependencies ?? {}) as Record<string, string>;
      const merged: Record<string, string> = { ...current };
      for (const name of adds) merged[name] = "workspace:*";
      json.dependencies = Object.fromEntries(
        Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
      );
      const trailing = text.endsWith("\n") ? "\n" : "";
      return {
        pkg,
        path: manifestPath(pkg),
        adds: [...adds].sort(),
        text: `${JSON.stringify(json, null, indentOf(text))}${trailing}`,
      };
    });
  }
}

/** How a cycle reads to a person: `@a -> @b -> @a`. */
export const describeCycle = (cycle: readonly WorkspacePackage[]): string =>
  cycle.map(packageLabel).join(" -> ");

/** The executable `name` on `PATH`, the first directory that holds one, or `undefined`. */
export function onPath(
  name: string,
  path: string | undefined = process.env.PATH,
): string | undefined {
  const names =
    process.platform === "win32"
      ? [`${name}.cmd`, `${name}.exe`, name]
      : [name];
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const file of names) {
      const candidate = join(dir, file);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return undefined;
}

const LOCKFILE = "pnpm-lock.yaml";

/**
 * The `pnpm-lock.yaml` text pnpm writes for the workspace once `edits` are on disk. Each edit is
 * written, `pnpm install --lockfile-only` runs at the repository root, and every file it touched is
 * put back as it was, whether pnpm succeeds or not, so the caller can still refuse with the tree
 * unchanged. `--lockfile-only` reads `package.json` files alone and writes nothing but the lockfile.
 */
export function lockfileFor(
  repoRoot: string,
  edits: readonly ManifestEdit[],
  pnpm: string,
): { readonly path: string; readonly text: string } {
  const lock = join(repoRoot, LOCKFILE);
  const lockBefore = existsSync(lock) ? readFileSync(lock, "utf8") : undefined;
  const originals = edits.map((e) => {
    const path = join(repoRoot, e.path);
    return { path, text: readFileSync(path, "utf8") };
  });
  try {
    for (const edit of edits)
      writeFileSync(join(repoRoot, edit.path), edit.text);
    try {
      execFileSync(pnpm, ["install", "--lockfile-only"], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    } catch (error) {
      const said =
        error instanceof Error && "stderr" in error
          ? String((error as { stderr: unknown }).stderr).trim() ||
            String((error as { stdout?: unknown }).stdout ?? "").trim()
          : String(error);
      throw new Error(
        `pnpm install --lockfile-only failed, refusing before any commit:\n${said}`,
      );
    }
    return { path: LOCKFILE, text: readFileSync(lock, "utf8") };
  } finally {
    for (const { path, text } of originals) writeFileSync(path, text);
    if (lockBefore === undefined) rmSync(lock, { force: true });
    else writeFileSync(lock, lockBefore);
  }
}
