import { posix } from "node:path";
import { type RoleConfig, roleOf, type Vocabulary } from "../vocabulary.js";
import type {
  GraphPull,
  Manifest,
  MoveRow,
  PinnedRow,
  ReviewRow,
  VerdictRow,
} from "./manifest.js";

export const CONFIDENCE_FLOOR = 0.8;

/** One resolved relative import between two scope files: `from` imports `to`. Repo-relative. */
export type ImportEdge = { readonly from: string; readonly to: string };

export type PlanInput = {
  readonly scope: string;
  readonly vocabulary: Vocabulary;
  readonly features: readonly string[];
  readonly floor: number;
  readonly verdicts: readonly VerdictRow[];
  /** Every file under `<scope>/src`, repo-relative. */
  readonly tree: readonly string[];
  /** Files that must not move, keyed by repo-relative path, valued by the reason. */
  readonly entries: ReadonlyMap<string, string>;
  /** The scope's import graph; a file moves only where its pull agrees with Jev. */
  readonly edges: readonly ImportEdge[];
};

const kebab = (feature: string) => feature.replaceAll("_", "-");

function homeOf(scope: string, feature: string, role: RoleConfig): string {
  if (role.shared) return posix.join(scope, "src", role.dir);
  return posix.join(scope, "src", kebab(feature), role.dir);
}

const TEST_SUFFIX = /\.(test|spec)\.tsx?$/;

const stemOf = (path: string) => posix.basename(path).replace(/\.tsx?$/, "");

function ownerOf(test: string, tree: ReadonlySet<string>): string | undefined {
  const dir = posix.dirname(test);
  const name = posix.basename(test);
  return [...tree]
    .filter(
      (p) =>
        posix.dirname(p) === dir &&
        !TEST_SUFFIX.test(p) &&
        /\.tsx?$/.test(p) &&
        name.startsWith(`${stemOf(p)}.`),
    )
    .sort((a, b) => stemOf(b).length - stemOf(a).length)[0];
}

function companionsOf(path: string, tree: ReadonlySet<string>): string[] {
  return [...tree].filter(
    (p) => TEST_SUFFIX.test(p) && ownerOf(p, tree) === path,
  );
}

type Placed = {
  readonly row: VerdictRow;
  readonly feature: string;
  readonly role: string;
  readonly home: string;
};

function targetsOf(placed: readonly Placed[]): Map<string, string> {
  const byTarget = new Map<string, Placed[]>();
  for (const p of placed) {
    const to = posix.join(p.home, posix.basename(p.row.path));
    byTarget.set(to, [...(byTarget.get(to) ?? []), p]);
  }
  const out = new Map<string, string>();
  for (const [to, group] of byTarget) {
    for (const p of group) {
      out.set(
        p.row.path,
        group.length === 1
          ? to
          : posix.join(
              p.home,
              posix.basename(posix.dirname(p.row.path)),
              posix.basename(p.row.path),
            ),
      );
    }
  }
  return out;
}

function checkFeatures(
  vocabulary: Vocabulary,
  features: readonly string[],
): void {
  const unknown = features.filter(
    (f) => !Object.hasOwn(vocabulary.features, f),
  );
  if (unknown.length > 0) {
    throw new Error(
      `not in the vocabulary: ${unknown.join(", ")}; known features: ${Object.keys(vocabulary.features).join(", ")}`,
    );
  }
}

function roleFor(vocabulary: Vocabulary, row: VerdictRow): RoleConfig {
  const role = roleOf(vocabulary, row.answers.role.choice);
  if (role === undefined) {
    throw new Error(
      `${row.path} has role "${row.answers.role.choice}", which the vocabulary does not name; re-run sweep with the current vocabulary`,
    );
  }
  return role;
}

/**
 * Each file's graph pull: its import edges, both directions, to neighbours Jev put in a named
 * feature, grouped by that neighbour's feature; the feature holding a strict majority is the pull.
 * An edge listed twice counts once, and a self-import not at all.
 */
export function graphPulls(
  edges: readonly ImportEdge[],
  featureOf: ReadonlyMap<string, string>,
): (path: string) => GraphPull {
  const counts = new Map<string, Map<string, number>>();
  const count = (file: string, neighbour: string) => {
    const feature = featureOf.get(neighbour);
    if (feature === undefined) return;
    const byFeature = counts.get(file) ?? new Map<string, number>();
    byFeature.set(feature, (byFeature.get(feature) ?? 0) + 1);
    counts.set(file, byFeature);
  };
  const seen = new Set<string>();
  for (const { from, to } of edges) {
    const key = JSON.stringify([from, to]);
    if (from === to || seen.has(key)) continue;
    seen.add(key);
    count(from, to);
    count(to, from);
  }
  return (path) => {
    const byFeature = counts.get(path) ?? new Map<string, number>();
    const total = [...byFeature.values()].reduce((n, c) => n + c, 0);
    for (const [feature, n] of byFeature) {
      if (2 * n > total) return { feature, share: n / total, edges: total };
    }
    return { feature: null, edges: total };
  };
}

/**
 * Where a file lands given the feature Jev would move it to (named and at or above the floor) and
 * the feature the graph pulls it to: a move only when both name the same one, review when exactly
 * one names a feature or they name different ones, unlisted when neither does.
 */
export function agreementOf(
  jev: string | null,
  graph: string | null,
): "move" | "review" | "unlisted" {
  if (jev === null && graph === null) return "unlisted";
  return jev === graph ? "move" : "review";
}

/**
 * Turn sweep verdicts and the import graph into a move manifest. A file moves to its feature and
 * role folder, carrying its colocated tests, only when Jev and the graph agree on the feature (see
 * `agreementOf`); a disagreement goes to review with both opinions; an entry file is pinned. Pure —
 * the tree, verdicts, entries and edges are all handed in.
 */
export function planManifest(input: PlanInput): Manifest {
  checkFeatures(input.vocabulary, input.features);
  const tree = new Set(input.tree);
  const wanted = new Set<string>(input.features);
  const judged = input.verdicts
    .filter((v) => v.path.startsWith(`${input.scope}/src/`))
    .filter((v) => tree.has(v.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const pullOf = graphPulls(
    input.edges,
    new Map(
      judged
        .filter((v) => wanted.has(v.answers.feature.choice))
        .map((v) => [v.path, v.answers.feature.choice]),
    ),
  );

  const pinned: PinnedRow[] = [];
  const review: ReviewRow[] = [];
  const placed: Placed[] = [];
  for (const row of judged) {
    const { choice: feature, confidence } = row.answers.feature;
    const graph = pullOf(row.path);
    const verdict = agreementOf(
      wanted.has(feature) && confidence >= input.floor ? feature : null,
      graph.feature,
    );
    // An entry file is pinned whenever either side would list it, and — as before the graph had a
    // say — whenever Jev put it in a named feature at all.
    const listed = verdict !== "unlisted" || wanted.has(feature);
    const entry = listed ? input.entries.get(row.path) : undefined;
    if (entry !== undefined) {
      pinned.push({ path: row.path, entry });
      continue;
    }
    const role = row.answers.role.choice;
    if (verdict === "unlisted") continue;
    if (verdict === "review") {
      review.push({ path: row.path, feature, role, confidence, graph });
      continue;
    }
    placed.push({
      row,
      feature,
      role,
      home: homeOf(input.scope, feature, roleFor(input.vocabulary, row)),
    });
  }

  const targets = targetsOf(placed);
  const moves: MoveRow[] = placed.flatMap(({ row, feature, role }) => {
    const to = targets.get(row.path) ?? row.path;
    const base = { feature, role, confidence: row.answers.feature.confidence };
    return [
      { from: row.path, to, ...base },
      ...companionsOf(row.path, tree)
        .filter((test) => !input.entries.has(test))
        .map((test) => ({
          from: test,
          to: posix.join(posix.dirname(to), posix.basename(test)),
          ...base,
        })),
    ];
  });

  return {
    scope: input.scope,
    features: [...input.features],
    floor: input.floor,
    moves: moves
      .filter((m) => m.from !== m.to)
      .sort((a, b) => a.from.localeCompare(b.from)),
    review,
    pinned,
  };
}
