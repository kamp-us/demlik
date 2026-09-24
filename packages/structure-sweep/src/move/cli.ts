import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { DEFAULTS, scopeOf, underRoot } from "../cli-paths.js";
import { git, repoRootOf } from "../git.js";
import { loadVocabulary, type Vocabulary } from "../vocabulary.js";
import { applyManifest } from "./apply.js";
import { entryFiles } from "./entries.js";
import { Manifest, VerdictRow } from "./manifest.js";
import { CONFIDENCE_FLOOR, planManifest } from "./plan.js";

export const MOVE_USAGE = `structure-sweep move plan --scope <folder> --feature <key>... [options]
structure-sweep move apply [--manifest <file>]

  plan   Write a manifest moving every confidently-judged file of the named features into
         <folder>/src/<feature>/<role dir>. Entry files are pinned and never moved.
  apply  Move the manifest's files, rewrite their imports and stage the result. A second
         apply over the same manifest changes nothing.

  --config <file>       vocabulary (default: ${DEFAULTS.config})
  --verdicts <file>     sweep output (default: ${DEFAULTS.verdicts})
  --floor <0..1>        below this feature confidence a file goes to review (default: ${CONFIDENCE_FLOOR})
  --manifest <file>     manifest to write or apply (default: ${DEFAULTS.manifest})`;

export interface PlanScopeInput {
  readonly root: string;
  readonly scope: string;
  readonly vocabulary: Vocabulary;
  readonly features: readonly string[];
  readonly floor: number;
  readonly verdicts: readonly VerdictRow[];
}

/** `planManifest` over the scope as git tracks it, with its entry files read from the disk. */
export function planScope(input: PlanScopeInput): Manifest {
  const tree = git(input.root, ["ls-files", "--", input.scope])
    .split("\n")
    .filter(Boolean);
  return Manifest.parse(
    planManifest({
      ...input,
      tree,
      entries: entryFiles(input.root, input.scope, tree),
    }),
  );
}

function readJson(path: string, what: string): unknown {
  if (!existsSync(path)) throw new Error(`no ${what} at ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function moveCommand(argv: readonly string[], cwd: string): void {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      config: { type: "string", default: DEFAULTS.config },
      verdicts: { type: "string", default: DEFAULTS.verdicts },
      scope: { type: "string" },
      feature: { type: "string", multiple: true, default: [] },
      floor: { type: "string", default: String(CONFIDENCE_FLOOR) },
      manifest: { type: "string", default: DEFAULTS.manifest },
    },
  });
  const root = repoRootOf(cwd);
  const manifestPath = underRoot(root, values.manifest);
  const [verb] = positionals;

  if (verb === "plan") {
    if (values.scope === undefined)
      throw new Error(`--scope is required\n\n${MOVE_USAGE}`);
    if (values.feature.length === 0)
      throw new Error(`name at least one --feature\n\n${MOVE_USAGE}`);
    const manifest = planScope({
      root,
      scope: scopeOf(root, cwd, values.scope),
      vocabulary: loadVocabulary(underRoot(root, values.config)),
      features: values.feature,
      floor: z.coerce.number().min(0).max(1).parse(values.floor),
      verdicts: z
        .array(VerdictRow)
        .parse(readJson(underRoot(root, values.verdicts), "sweep verdicts")),
    });
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
    console.error(
      `${manifest.moves.length} moves, ${manifest.review.length} to review, ${manifest.pinned.length} pinned → ${manifestPath}`,
    );
    return;
  }
  if (verb === "apply") {
    const manifest = Manifest.parse(readJson(manifestPath, "move manifest"));
    console.log(JSON.stringify(applyManifest(root, manifest), null, 1));
    return;
  }
  throw new Error(MOVE_USAGE);
}
