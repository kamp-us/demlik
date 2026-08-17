/**
 * The two committed fabrika lane templates, vendored.
 *
 *   upstream repo:   github.com/kamp-us/phoenix
 *   upstream paths:  packages/fabrika-cli/src/lane/templates/coder.workflow.json
 *                    packages/fabrika-cli/src/lane/templates/chore.workflow.json
 *   upstream commit: 300faa48bee007db46adaa2141e6182ed3e5148b
 *
 * JSON cannot carry a comment, which is why the provenance lives here and the
 * documents live untouched next door in `vendor/` (kept out of biome so they
 * stay byte-identical and re-vendoring is a one-line diff).
 *
 * These are not decoration. They are the golden test's INPUT: the importer runs
 * on the same bytes fabrika's own compiler runs on, and the two results are
 * asserted against each other. The `coder` template is the single-issue lane;
 * `chore` is the second shape — a different task id, a different event
 * namespace, a self-loop (`unpark --WIP--> unpark`), one parked state instead of
 * two, and a `trigger` field the coder template does not have.
 */
import chore from "./vendor/chore.workflow.json";
import coder from "./vendor/coder.workflow.json";

export const TEMPLATES = [
  { name: "coder.workflow.json", document: coder as unknown },
  { name: "chore.workflow.json", document: chore as unknown },
] as const;

export { chore, coder };
