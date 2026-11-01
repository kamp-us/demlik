import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { type Project, type SourceFile, ts } from "ts-morph";
import { absurd } from "../absurd.js";
import {
  exactRenames,
  git,
  ignoredPaths,
  stagedPaths,
  trackedPaths,
  uncommittedPaths,
} from "../git.js";
import { canonicalJson, contentHash } from "../lowering/artifact.js";
import {
  describeUnfollowed,
  describeUnreachable,
  importerPackageSources,
  PackageTree,
  rewriteCrossings,
} from "./crossing.js";
import {
  describeCycle,
  LOCKFILE,
  lockfileFor,
  type ManifestEdit,
  onPath,
  type PackageEdge,
  WorkspaceDependencies,
} from "./dependencies.js";
import {
  type Exists,
  hasDangling,
  heal,
  type MovedModules,
  movedModules,
} from "./heal.js";
import {
  type HandPlan,
  Manifest,
  type PathMove,
  parseHandPlan,
} from "./manifest.js";
import { applyMoves } from "./mover.js";
import { loadMoveProject } from "./project.js";
import { moduleLiterals, sourceCandidates } from "./specifier.js";
import {
  crossesPackages,
  packageLabel,
  placeRow,
  readWorkspace,
  type Workspace,
} from "./workspace.js";

export type RowState =
  | { readonly kind: "pending"; readonly row: PathMove }
  | { readonly kind: "done"; readonly row: PathMove }
  | { readonly kind: "absent"; readonly row: PathMove }
  | { readonly kind: "conflict"; readonly row: PathMove };

export function stateOf(repoRoot: string, row: PathMove): RowState {
  const from = existsSync(join(repoRoot, row.from));
  const to = existsSync(join(repoRoot, row.to));
  if (from && to) return { kind: "conflict", row };
  if (from) return { kind: "pending", row };
  if (to) return { kind: "done", row };
  return { kind: "absent", row };
}

/** The commits one apply made: the renames, then the import rewrites; `null` where it made none. */
export type ApplyCommits = {
  readonly rename: string | null;
  readonly rewrite: string | null;
};

export type ApplyReport = {
  readonly pending: number;
  readonly done: number;
  readonly absent: readonly string[];
  readonly moved: number;
  readonly healed: number;
  readonly specifiersRewritten: number;
  /** Each `workspace:*` dependency the rewrite commit added, as `<importing package> -> <name>`. */
  readonly dependenciesAdded: readonly string[];
  /** Files the rewrite commit changed. */
  readonly filesTouched: number;
  /** `untouched` when nothing needed rewriting, `no formatter` when the repo has no biome, else biome's verdict. */
  readonly lint: string;
  readonly commits: ApplyCommits;
  readonly staleStringRefs: readonly string[];
  readonly millis: number;
};

const specifiersOf = (sf: SourceFile) =>
  moduleLiterals(sf).map((l) => l.getLiteralValue());

const differing = (before: readonly string[], after: readonly string[]) =>
  before.reduce((n, spec, i) => n + (after[i] === spec ? 0 : 1), 0);

/**
 * A path with a TypeScript extension: the tracked files apply reads as sources, and in
 * {@link staleRefs} the rows whose old path cannot be spelled as a plain relative string beside
 * them. Which rows ts-morph moves is decided in {@link planRewrite} by whether the move project
 * holds the file as a module.
 */
const TS_EXTENSION = /\.[cm]?tsx?$/;

/**
 * A file a move across a package line reads for importers. JavaScript counts here whatever the
 * tsconfig says, since `next.config.mjs` breaks as surely as a `.ts` file on a stale import.
 */
const MODULE_EXTENSION = /\.[cm]?[jt]sx?$/;

/** Old paths still written as text somewhere — a string a move cannot rewrite, for a human to read. */
function staleRefs(repoRoot: string, moved: readonly PathMove[]): string[] {
  const hits = new Set<string>();
  for (const row of moved.filter((r) => !TS_EXTENSION.test(r.from)))
    for (const line of relativeRefs(repoRoot, row.from)) hits.add(line);
  for (const { from } of moved) {
    const needle = from.replace(/\.tsx?$/, "");
    let out = "";
    try {
      out = git(repoRoot, ["grep", "-n", "-F", needle, "--", ":!*.md"]);
    } catch {
      continue;
    }
    for (const line of out.split("\n").filter(Boolean)) hits.add(line);
  }
  return [...hits].sort();
}

const QUOTED_RELATIVE = /["'`](\.\.?\/[^"'`\n]+)["'`]/g;

/**
 * Lines holding a quoted relative path that, read from the directory of the file it is written in,
 * still names `from` — a `new URL("./run.sh", import.meta.url)` beside a script that moved. The
 * repo-relative grep in {@link staleRefs} cannot see these, since they spell only the file's name.
 */
function relativeRefs(repoRoot: string, from: string): string[] {
  const name = from.split("/").at(-1) ?? from;
  let out = "";
  try {
    out = git(repoRoot, ["grep", "-n", "-z", "-F", name, "--", ":!*.md"]);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const record of out.split("\n").filter(Boolean)) {
    const [path, line, ...rest] = record.split("\0");
    if (path === undefined || line === undefined) continue;
    const text = rest.join("\0");
    const dir = dirname(join(repoRoot, path));
    const names = [...text.matchAll(QUOTED_RELATIVE)].some(
      ([, literal]) =>
        literal !== undefined && resolve(dir, literal) === join(repoRoot, from),
    );
    if (names) hits.push(`${path}:${line}:${text}`);
  }
  return hits;
}

type Ledger = {
  readonly pending: PathMove[];
  readonly conflicts: PathMove[];
  readonly absent: string[];
  done: number;
};

function classify(repoRoot: string, rows: readonly PathMove[]): Ledger {
  const ledger: Ledger = { pending: [], conflicts: [], absent: [], done: 0 };
  for (const state of rows.map((row) => stateOf(repoRoot, row))) {
    switch (state.kind) {
      case "pending":
        ledger.pending.push(state.row);
        break;
      case "done":
        ledger.done += 1;
        break;
      case "absent":
        ledger.absent.push(state.row.from);
        break;
      case "conflict":
        ledger.conflicts.push(state.row);
        break;
      default:
        return absurd(state);
    }
  }
  return ledger;
}

/** Biome over the touched files when the repo has it installed; without it, files stay as ts-morph wrote them. */
function format(repoRoot: string, paths: readonly string[]): string {
  const biome = join(repoRoot, "node_modules/.bin/biome");
  if (!existsSync(biome)) return "no formatter";
  try {
    execFileSync(
      biome,
      ["check", "--write", "--no-errors-on-unmatched", ...paths],
      {
        cwd: repoRoot,
        stdio: "pipe",
      },
    );
    return "clean";
  } catch (error) {
    return error instanceof Error
      ? (error.message.split("\n")[0] ?? "biome failed")
      : "biome failed";
  }
}

const RENAME_TRAILER = "Structure-Sweep-Step: rename";

/**
 * What made the rows, and the content hash of the file that holds them. The hash goes into a
 * trailer on both commits, so a re-run can tell its own rename commit at HEAD.
 */
type Planner =
  | { readonly kind: "manifest"; readonly id: string }
  | { readonly kind: "hand-plan"; readonly id: string };

/** The input both kinds of plan share: the scope apply loads, the from/to rows, and their planner. */
type MoveSet = {
  readonly scope: string;
  readonly moves: readonly PathMove[];
  readonly planner: Planner;
};

const files = (count: number) => `${count} file${count === 1 ? "" : "s"}`;

/** The trailer naming the plan, and each commit's subject and body, for one kind of planner. */
const WORDING = {
  manifest: {
    trailer: "Structure-Sweep-Manifest",
    rename: (count: number) =>
      `structure-sweep move: rename ${files(count)} into feature folders

Content unchanged, so git records each move as a 100% rename and history follows it.
The import rewrites follow in the next commit.`,
    rewrite: `structure-sweep move: rewrite imports after the renames

Specifier rewrites, heals and formatting for the files the previous commit moved.`,
  },
  "hand-plan": {
    trailer: "Structure-Sweep-Plan",
    rename: (count: number) =>
      `structure-sweep move: rename ${files(count)} as hand-planned

The moves were hand-planned; no sweep judged them.
Content unchanged, so git records each move as a 100% rename and history follows it.
The import rewrites follow in the next commit.`,
    rewrite: `structure-sweep move: rewrite imports after the hand-planned renames

Specifier rewrites, heals and formatting for the files the previous commit moved.`,
  },
} as const satisfies Record<
  Planner["kind"],
  {
    readonly trailer: string;
    readonly rename: (count: number) => string;
    readonly rewrite: string;
  }
>;

const planTrailer = ({ kind, id }: Planner) =>
  `${WORDING[kind].trailer}: ${id}`;

const renameMessage = (count: number, planner: Planner) =>
  `${WORDING[planner.kind].rename(count)}

${RENAME_TRAILER}
${planTrailer(planner)}
`;

const rewriteMessage = (planner: Planner) =>
  `${WORDING[planner.kind].rewrite}

${planTrailer(planner)}
`;

function commit(repoRoot: string, message: string): string {
  git(repoRoot, ["commit", "-q", "-m", message]);
  return git(repoRoot, ["rev-parse", "HEAD"]).trim();
}

/** One commit holding only the pending renames, each file byte-identical at its new path. */
function commitRenames(
  repoRoot: string,
  pending: readonly PathMove[],
  planner: Planner,
): string {
  for (const row of pending) {
    mkdirSync(dirname(join(repoRoot, row.to)), { recursive: true });
    git(repoRoot, ["mv", "--", row.from, row.to]);
  }
  return commit(repoRoot, renameMessage(pending.length, planner));
}

/**
 * The rows HEAD renamed, when HEAD is this plan's rename commit — the renames whose import
 * rewrites are still owed, whether this run just made that commit or an earlier one stopped after it.
 */
function renamedAtHead(repoRoot: string, set: MoveSet): PathMove[] {
  const message = git(repoRoot, ["log", "-1", "--format=%B", "HEAD"]);
  const lines = new Set(message.split("\n"));
  if (!lines.has(RENAME_TRAILER) || !lines.has(planTrailer(set.planner)))
    return [];
  const destinations = new Set(
    exactRenames(repoRoot, "HEAD").map(({ to }) => to),
  );
  return set.moves.filter((row) => destinations.has(row.to));
}

/** One file the rewrite changes: the path its text was read from, where it lands, and its new text. */
type Edit = {
  readonly origin: string;
  readonly path: string;
  readonly text: string;
};

type Rewrite = {
  readonly edits: readonly Edit[];
  readonly healed: number;
  readonly specifiersRewritten: number;
  /** The package edge of every import the rewrite carries across a package line. */
  readonly crossings: readonly PackageEdge[];
};

const NO_REWRITE: Rewrite = {
  edits: [],
  healed: 0,
  specifiersRewritten: 0,
  crossings: [],
};

/**
 * The tree once every row is renamed: a row's destination exists and its source does not, whatever
 * the disk holds now. Heal resolves specifiers against this, so the rewrite comes out the same
 * whether the renames are still to be made or an earlier run already committed them.
 */
function renamedTree(repoRoot: string, rows: readonly PathMove[]): Exists {
  const sources = new Set(rows.map((r) => join(repoRoot, r.from)));
  const destinations = new Set(rows.map((r) => join(repoRoot, r.to)));
  return (path) =>
    destinations.has(path) || (!sources.has(path) && existsSync(path));
}

/** The tree before any row is renamed: `renamedTree` the other way round. */
function originalTree(repoRoot: string, rows: readonly PathMove[]): Exists {
  const sources = new Set(rows.map((r) => join(repoRoot, r.from)));
  const destinations = new Set(rows.map((r) => join(repoRoot, r.to)));
  return (path) =>
    sources.has(path) || (!destinations.has(path) && existsSync(path));
}

const relativeSpecifier = (fromDir: string, to: string) => {
  const rel = relative(fromDir, to);
  return rel.startsWith(".") ? rel : `./${rel}`;
};

/**
 * Point every module specifier that named a moved non-TypeScript file (a `.json` fixture, say) at
 * its new path. ts-morph cannot move such a file, so it rewrites none of its importers; each
 * specifier is read as it was written before any move, from the directory its file sat in then,
 * and re-derived from the directory that file sits in now. The same goes for a moved file's import
 * of such a file left where it is: ts-morph drops a `.json`, and leaves any other as written.
 */
function repointOtherFiles(
  project: Project,
  repoRoot: string,
  rows: readonly PathMove[],
  unheld: readonly PathMove[],
  before: ReadonlyMap<SourceFile, { readonly specifiers: readonly string[] }>,
  dirBefore: ReadonlyMap<SourceFile, string>,
): void {
  const destination = new Map(
    unheld.map((r) => [join(repoRoot, r.from), join(repoRoot, r.to)]),
  );
  const moved = new Set(rows.map((r) => join(repoRoot, r.from)));
  for (const sf of project.getSourceFiles()) {
    const written = before.get(sf)?.specifiers;
    const dir = dirBefore.get(sf);
    if (written === undefined || dir === undefined) continue;
    const now = dirname(sf.getFilePath());
    moduleLiterals(sf).forEach((literal, i) => {
      const was = written[i];
      if (was === undefined || !was.startsWith(".")) return;
      const path = resolve(dir, was);
      const to =
        destination.get(path) ??
        (now !== dir && !moved.has(path) && isOtherFile(path)
          ? path
          : undefined);
      if (to !== undefined) literal.setLiteralValue(relativeSpecifier(now, to));
    });
  }
}

/** A file on disk a specifier names by its full path, with no TypeScript source answering it first. */
function isOtherFile(path: string): boolean {
  return (
    extname(path) !== "" &&
    existsSync(path) &&
    statSync(path).isFile() &&
    !sourceCandidates(path).some((candidate) => existsSync(candidate))
  );
}

/**
 * Every file the import rewrite for `rows` changes, worked out in memory with nothing written.
 * ts-morph holds each row's file at its old path (reading it from its new one when an earlier run
 * already renamed it) and moves it, so every specifier is rewritten from the directory it was
 * written in; heal then fixes any relative specifier still dangling in the renamed tree. Each edit
 * names the path its text was read from, so apply can check git tracks it before committing.
 *
 * With a `workspace` — a manifest moving a file across a package line — the project also holds
 * every workspace package with an importer of a moved file, its tracked JavaScript included, and
 * each import the move touched is rewritten to match its ends' packages (`rewriteCrossings`). An
 * import no `exports` entry carries across, and an import a row touches that apply cannot follow to
 * a file, throw before anything is written.
 */
function planRewrite(
  repoRoot: string,
  scope: string,
  rows: readonly PathMove[],
  moved: MovedModules,
  workspace: Workspace | null,
): Rewrite {
  const scopeRoot = join(repoRoot, scope);
  const project = loadMoveProject(scopeRoot, repoRoot);
  const trees =
    workspace === null
      ? null
      : {
          before: new PackageTree(
            repoRoot,
            workspace,
            originalTree(repoRoot, rows),
          ),
          after: new PackageTree(
            repoRoot,
            workspace,
            renamedTree(repoRoot, rows),
          ),
        };
  if (trees !== null) {
    const endpoints = rows
      .flatMap((r) => [r.from, r.to])
      .map((p) => join(repoRoot, p))
      .filter((p) => existsSync(p));
    for (const file of [
      ...importerPackageSources(
        trackedMatching(repoRoot, MODULE_EXTENSION),
        rows,
        trees.before,
      ),
      ...endpoints,
    ])
      if (project.getSourceFile(file) === undefined)
        project.addSourceFileAtPath(file);
  }
  const renamedFrom = new Map<SourceFile, string>();
  for (const row of rows) {
    const at = project.getSourceFile(join(repoRoot, row.to));
    if (at === undefined) continue;
    const text = at.getFullText();
    project.removeSourceFile(at);
    renamedFrom.set(
      project.createSourceFile(join(repoRoot, row.from), text),
      row.to,
    );
  }
  const before = new Map(
    project.getSourceFiles().map((sf) => [
      sf,
      {
        origin: renamedFrom.get(sf) ?? relative(repoRoot, sf.getFilePath()),
        text: sf.getFullText(),
        specifiers: specifiersOf(sf),
      },
    ]),
  );
  const dirBefore = new Map(
    project.getSourceFiles().map((sf) => [sf, dirname(sf.getFilePath())]),
  );
  // ts-morph moves every row whose file the move project holds as a module (a `.js` under
  // allowJs too) and rewrites its importers. A file the project cannot hold goes through the
  // repoint path, and so does a JSON file: resolveJsonModule pulls it into the project, but
  // ts-morph's move rewrites its importers wrong (dropping `.json`, keeping the old directory).
  const held = (r: PathMove) => {
    const sf = project.getSourceFile(join(repoRoot, r.from));
    return sf !== undefined && sf.getScriptKind() !== ts.ScriptKind.JSON;
  };
  applyMoves(
    project,
    scopeRoot,
    rows
      .filter(held)
      .map((r) => [
        relative(scopeRoot, join(repoRoot, r.from)),
        relative(scopeRoot, join(repoRoot, r.to)),
      ]),
  );
  repointOtherFiles(
    project,
    repoRoot,
    rows,
    rows.filter((r) => !held(r)),
    before,
    dirBefore,
  );
  const healed = heal(
    project.getSourceFiles(),
    moved,
    renamedTree(repoRoot, rows),
  );
  const crossed =
    trees === null
      ? { unreachable: [], unfollowed: [], edges: [] }
      : rewriteCrossings(
          project.getSourceFiles(),
          rows,
          trees.before,
          trees.after,
        );
  const refusals = [
    ...(crossed.unreachable.length > 0
      ? [
          `rows would import a file across a package line that no exports entry reaches; refusing before any commit:\n${crossed.unreachable.map((u) => `  ${describeUnreachable(repoRoot, u)}`).join("\n")}`,
        ]
      : []),
    ...(crossed.unfollowed.length > 0
      ? [
          `rows touch imports apply cannot follow to a file, so it cannot carry them; refusing before any commit:\n${crossed.unfollowed.map((u) => `  ${describeUnfollowed(repoRoot, u)}`).join("\n")}`,
        ]
      : []),
  ];
  if (refusals.length > 0) throw new Error(refusals.join("\n"));
  const edits: Edit[] = [];
  let specifiersRewritten = 0;
  for (const sf of project.getSourceFiles()) {
    const was = before.get(sf);
    const text = sf.getFullText();
    if (was === undefined || was.text === text) continue;
    edits.push({ origin: was.origin, path: sf.getFilePath(), text });
    specifiersRewritten += differing(was.specifiers, specifiersOf(sf));
  }
  return { edits, healed, specifiersRewritten, crossings: crossed.edges };
}

/** The `package.json` edits and lockfile a rewrite's crossings call for; none when it adds no dependency. */
type Dependencies = {
  readonly added: readonly PackageEdge[];
  readonly manifests: readonly ManifestEdit[];
  readonly lockfile: { readonly path: string; readonly text: string } | null;
};

const NO_DEPENDENCIES: Dependencies = {
  added: [],
  manifests: [],
  lockfile: null,
};

/**
 * The `workspace:*` dependencies the rewrite's crossings leave undeclared, the `package.json` text
 * that declares each, and the lockfile pnpm writes for them — all worked out with the tree left as
 * it was. Throws, before any commit, when an added dependency closes a cycle between workspace
 * packages, or when one is owed and git ignores the lockfile or no `pnpm` is on `PATH`. A rewrite
 * that adds no dependency never looks for pnpm.
 */
function planDependencies(
  repoRoot: string,
  workspace: Workspace,
  crossings: readonly PackageEdge[],
): Dependencies {
  if (crossings.length === 0) return NO_DEPENDENCIES;
  const declared = WorkspaceDependencies.read(repoRoot, workspace);
  const added = declared.undeclared(crossings);
  if (added.length === 0) return NO_DEPENDENCIES;
  const cycles = declared.cyclesClosedBy(added);
  if (cycles.length > 0)
    throw new Error(
      `rows would make workspace packages depend on each other, which pnpm cannot order; refusing before any commit:\n${cycles.map((c) => `  ${describeCycle(c)}`).join("\n")}`,
    );
  const manifests = declared.edits(added);
  if (ignoredPaths(repoRoot, [LOCKFILE]).size > 0)
    throw new Error(
      `git ignores ${LOCKFILE}, so the rewrite commit could not carry the lockfile the added workspace:* dependencies need; refusing before any commit. Track it or stop ignoring it, then apply again.`,
    );
  const pnpm = onPath("pnpm");
  if (pnpm === undefined)
    throw new Error(
      `pnpm was not found on PATH, and the rewrite must add ${added.length === 1 ? "a workspace:* dependency" : "workspace:* dependencies"} and update pnpm-lock.yaml; refusing before any commit:\n${added.map((e) => `  ${packageLabel(e.from)} -> ${e.to.name}`).join("\n")}`,
    );
  return { added, manifests, lockfile: lockfileFor(repoRoot, manifests, pnpm) };
}

/**
 * The files the rewrite would change that git does not track: untracked, gitignored, or outside
 * the repository. Apply's commits can carry none of them, so it refuses to start while any exists.
 */
function untrackedEdits(
  repoRoot: string,
  rewrite: Rewrite,
  dependencies: Dependencies,
): string[] {
  const tracked = new Set(trackedPaths(repoRoot, "index"));
  return [
    ...rewrite.edits.map((edit) => edit.origin),
    ...dependencies.manifests.map((edit) => edit.path),
  ]
    .filter((path) => !tracked.has(path))
    .sort();
}

function trackedMatching(
  repoRoot: string,
  extension: RegExp,
  scope?: string,
): string[] {
  return trackedPaths(repoRoot, "index", scope)
    .filter((p) => extension.test(p) && existsSync(join(repoRoot, p)))
    .map((p) => join(repoRoot, p));
}

/**
 * Carry out a manifest over a clean tree in two commits. The first renames every pending row with
 * its content unchanged, so git scores each as a 100% rename and `git log --follow` keeps its
 * history; the second rewrites the imports that named the moved files, heals any specifier a move
 * left dangling and formats what changed. A re-run over a finished manifest commits nothing; one
 * over this manifest's rename commit alone makes the rewrite commit. A row may leave one workspace
 * package for another: every import that then crosses a package line is written as the target
 * package's name and `exports` subpath, each importing package's `package.json` gains the
 * `"<name>": "workspace:*"` dependency it does not yet declare, and `pnpm install --lockfile-only`
 * updates `pnpm-lock.yaml` to match, all in the rewrite commit. Refused before either commit: a row
 * whose destination no `exports` entry of its new package reaches, an import a move would carry
 * across a package line to a file no `exports` entry reaches, an import in a file moving across a
 * package line that names no file, a package-name import into a package a row leaves that apply
 * cannot follow to a file, an added dependency that closes a cycle between workspace packages, and an
 * added dependency with no `pnpm` on `PATH` or with a lockfile git ignores. Over the same HEAD it makes the same trees and messages, except that a manifest adding a dependency takes
 * its lockfile from the installed pnpm; one adding none never runs pnpm.
 */
export function applyManifest(
  repoRoot: string,
  manifest: Manifest,
): ApplyReport {
  const parsed = Manifest.parse(manifest);
  return applyMoveSet(repoRoot, {
    scope: parsed.scope,
    moves: parsed.moves,
    planner: { kind: "manifest", id: contentHash(canonicalJson(parsed)) },
  });
}

/**
 * Carry out a hand-written plan exactly as {@link applyManifest} carries out a manifest: the same
 * two commits, resume and no-op re-run, with both messages saying the moves were hand-planned and
 * naming the plan's content hash.
 */
export function applyHandPlan(repoRoot: string, plan: HandPlan): ApplyReport {
  const parsed = parseHandPlan(plan);
  return applyMoveSet(repoRoot, {
    scope: parsed.scope,
    moves: parsed.moves,
    planner: { kind: "hand-plan", id: contentHash(canonicalJson(parsed)) },
  });
}

function applyMoveSet(repoRoot: string, set: MoveSet): ApplyReport {
  const started = performance.now();
  const dirty = uncommittedPaths(repoRoot);
  if (dirty.length > 0)
    throw new Error(
      `uncommitted changes, refusing to apply over them; commit or discard them first:\n${dirty.map((d) => `  ${d}`).join("\n")}`,
    );
  const workspace = readWorkspace(repoRoot);
  const crossing = set.moves
    .map((row) => placeRow(workspace, row))
    .filter(crossesPackages);
  const landed = new PackageTree(
    repoRoot,
    workspace,
    renamedTree(repoRoot, set.moves),
  );
  const unexported = crossing.filter(
    ({ row }) => landed.specifierOf(join(repoRoot, row.to)) === undefined,
  );
  if (unexported.length > 0)
    throw new Error(
      `rows move a file into another workspace package where no exports entry reaches it, so nothing could import it there; refusing before any commit:\n${unexported.map(({ row, to }) => `  ${row.from} -> ${row.to}  (${to.name === undefined ? `${packageLabel(to)} has no name to import it by` : `no exports entry of ${to.name} reaches it`})`).join("\n")}`,
    );
  const { pending, conflicts, absent, done } = classify(repoRoot, set.moves);
  if (conflicts.length > 0)
    throw new Error(
      `both ends exist, refusing to guess:\n${conflicts.map((r) => `  ${r.from} -> ${r.to}`).join("\n")}`,
    );
  const moved = movedModules(repoRoot, set.moves);

  const rows = pending.length > 0 ? pending : renamedAtHead(repoRoot, set);
  const owed =
    rows.length > 0 ||
    hasDangling(trackedMatching(repoRoot, TS_EXTENSION, set.scope), moved);
  const rewrite = owed
    ? planRewrite(
        repoRoot,
        set.scope,
        rows,
        moved,
        crossing.length > 0 ? workspace : null,
      )
    : NO_REWRITE;
  const dependencies = planDependencies(repoRoot, workspace, rewrite.crossings);
  const untracked = untrackedEdits(repoRoot, rewrite, dependencies);
  if (untracked.length > 0)
    throw new Error(
      `the import rewrite would change files git does not track, refusing to apply; commit, move or delete them first:\n${untracked.map((p) => `  ${p}`).join("\n")}`,
    );

  const rename =
    pending.length > 0 ? commitRenames(repoRoot, pending, set.planner) : null;
  for (const edit of rewrite.edits) writeFileSync(edit.path, edit.text);
  for (const edit of dependencies.manifests)
    writeFileSync(join(repoRoot, edit.path), edit.text);
  const written = [
    ...rewrite.edits.map((edit) => relative(repoRoot, edit.path)),
    ...dependencies.manifests.map((edit) => edit.path),
  ];
  const { healed, specifiersRewritten } = rewrite;

  const lint = written.length > 0 ? format(repoRoot, written) : "untouched";
  if (dependencies.lockfile !== null) {
    writeFileSync(
      join(repoRoot, dependencies.lockfile.path),
      dependencies.lockfile.text,
    );
    written.push(dependencies.lockfile.path);
  }
  if (written.length > 0) git(repoRoot, ["add", "--", ...written]);
  const changed = stagedPaths(repoRoot);
  const rewriteSha =
    changed.length > 0 ? commit(repoRoot, rewriteMessage(set.planner)) : null;

  return {
    pending: pending.length,
    done,
    absent,
    moved: pending.length,
    healed,
    specifiersRewritten,
    dependenciesAdded: dependencies.added.map(
      (e) => `${packageLabel(e.from)} -> ${e.to.name}`,
    ),
    filesTouched: changed.length,
    lint,
    commits: { rename, rewrite: rewriteSha },
    staleStringRefs: staleRefs(repoRoot, set.moves),
    millis: Math.round(performance.now() - started),
  };
}
