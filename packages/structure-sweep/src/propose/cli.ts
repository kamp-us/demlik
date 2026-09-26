import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { DEFAULTS, scopeOf, underRoot } from "../cli-paths.js";
import { repoRootOf } from "../git.js";
import { readGraphFile } from "../sweep/graph.js";
import { loadVocabulary } from "../vocabulary.js";
import {
  DEFAULT_FEATURE_COUNT,
  DEFAULT_ROLES,
  renderProposePrompt,
} from "./prompt.js";
import { DEFAULT_DEPTH, gatherSignals } from "./signals.js";

export const PROPOSE_USAGE = `structure-sweep propose <folder>... [options]

  Gather repo signals for drafting a feature vocabulary and write a prompt that asks you, or your
  coding agent, to draft it. No model call, no network.

  --features <n>        features the prompt asks for (default: ${DEFAULT_FEATURE_COUNT})
  --config <file>       take the roles (and product line) from this vocabulary
                        (default: five built-in roles, see the README)
  --graph <file>        code-graph --graph JSON: clusters and cross-runtime calls (repeatable)
  --blind               leave out folders, packages and code-graph clusters, and name files in
                        the content signals by opaque id, so the draft comes from the code alone
  --ref <ref>           git tree to read folders, packages and file content from (default: HEAD)
  --depth <n>           folder levels listed under each folder (default: ${DEFAULT_DEPTH};
                        unused with --blind)
  --draft <file>        where the prompt says to write the config
                        (default: ${DEFAULTS.proposedConfig})
  --out <file>          signals JSON (default: ${DEFAULTS.signals})
  --prompt <file>       prompt (default: ${DEFAULTS.proposePrompt})
  --force               overwrite --out and --prompt when they exist`;

const count = (name: string, value: string, min: number) =>
  z.coerce
    .number()
    .int()
    .min(min, `--${name} must be an integer of at least ${min}`)
    .parse(value);

/** A path to print inside the prompt: repo-relative, so two checkouts write the same bytes. */
const shown = (root: string, path: string) =>
  relative(root, path).split("\\").join("/");

export function proposeCommand(argv: readonly string[], cwd: string): void {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      features: { type: "string", default: String(DEFAULT_FEATURE_COUNT) },
      config: { type: "string" },
      graph: { type: "string", multiple: true, default: [] },
      ref: { type: "string", default: "HEAD" },
      depth: { type: "string", default: String(DEFAULT_DEPTH) },
      draft: { type: "string", default: DEFAULTS.proposedConfig },
      out: { type: "string", default: DEFAULTS.signals },
      prompt: { type: "string", default: DEFAULTS.proposePrompt },
      force: { type: "boolean", default: false },
      blind: { type: "boolean", default: false },
    },
  });
  if (positionals.length === 0)
    throw new Error(`pass one or more folders\n\n${PROPOSE_USAGE}`);
  const root = repoRootOf(cwd);
  const outPath = underRoot(root, values.out);
  const promptPath = underRoot(root, values.prompt);
  const standing = [outPath, promptPath].filter((p) => existsSync(p));
  if (!values.force && standing.length > 0)
    throw new Error(
      `${standing.join(" and ")} already exist; pass --force to overwrite`,
    );

  const vocabulary =
    values.config === undefined
      ? undefined
      : loadVocabulary(underRoot(root, values.config));
  const graphPaths = values.graph.map((g) => underRoot(cwd, g));
  const signals = gatherSignals({
    root,
    ref: values.ref,
    scopes: positionals.map((p) => scopeOf(root, cwd, p)),
    depth: count("depth", values.depth, 1),
    blind: values.blind,
    graphs: graphPaths.map((g) => ({
      file: shown(root, g),
      graph: readGraphFile(g),
    })),
  });
  const prompt = renderProposePrompt({
    signals,
    features: count("features", values.features, 2),
    roles: vocabulary?.roles ?? DEFAULT_ROLES,
    product: vocabulary?.product,
    draft: shown(root, underRoot(root, values.draft)),
    graphs: graphPaths.map((g) => shown(root, g)),
  });

  for (const path of [outPath, promptPath])
    mkdirSync(dirname(path), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(signals, null, 1)}\n`);
  writeFileSync(promptPath, prompt);
  const { files, importClusters } = signals.content;
  const read = `${files} files, ${importClusters.total} import clusters`;
  console.error(
    `${signals.blind ? `blind: ${read}` : `${signals.directories.length} folders, ${signals.packages.length} packages, ${read}`} → ${outPath}, ${promptPath}`,
  );
  console.error(
    `next: draft the config from ${promptPath}, write it to ${values.draft}, then run sweep and score`,
  );
}
