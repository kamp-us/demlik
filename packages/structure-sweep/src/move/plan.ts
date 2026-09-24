import { posix } from "node:path";
import { type RoleConfig, roleOf, type Vocabulary } from "../vocabulary.js";
import type {
  Manifest,
  MoveRow,
  PinnedRow,
  ReviewRow,
  VerdictRow,
} from "./manifest.js";

export const CONFIDENCE_FLOOR = 0.8;

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
 * Turn sweep verdicts into a move manifest: each confident file in a wanted feature moves to its
 * feature and role folder, carrying its colocated tests; an entry file is pinned; anything under the
 * floor goes to review. Pure — the tree, verdicts and entries are all handed in.
 */
export function planManifest(input: PlanInput): Manifest {
  checkFeatures(input.vocabulary, input.features);
  const tree = new Set(input.tree);
  const wanted = new Set<string>(input.features);
  const inScope = input.verdicts
    .filter(
      (v) =>
        v.path.startsWith(`${input.scope}/src/`) &&
        wanted.has(v.answers.feature.choice),
    )
    .filter((v) => tree.has(v.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  const pinned: PinnedRow[] = [];
  const review: ReviewRow[] = [];
  const placed: Placed[] = [];
  for (const row of inScope) {
    const feature = row.answers.feature.choice;
    const entry = input.entries.get(row.path);
    if (entry !== undefined) {
      pinned.push({ path: row.path, entry });
      continue;
    }
    const role = row.answers.role.choice;
    const { confidence } = row.answers.feature;
    if (confidence < input.floor) {
      review.push({ path: row.path, feature, role, confidence });
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
