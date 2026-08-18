/**
 * REAL FABRIKA ARTIFACTS — produced by running the `fabrika` binary, not by us.
 *
 *   upstream repo:   github.com/kamp-us/phoenix
 *   upstream commit: e5a0bca787c0c6e709ab92556d84fd2f17fd25d3
 *   upstream entry:  packages/fabrika-cli/src/bin.ts   (node 26.2.0)
 *
 * Everything under `real/` is stdout or on-disk bytes of that binary, copied
 * byte for byte. Nothing in this repo wrote any of it, and nothing in this repo
 * may edit it — the point of the directory is that it is the OTHER side of the
 * process boundary. `real.test.ts` is what reads it.
 *
 * WHY IT EXISTS. Every other test in this module runs fabrika's VENDORED source
 * (`vendor/`) over event logs we composed ourselves. That is a strong oracle and
 * it is still one process: the binary had never been run, so "the CLI prints
 * what our parsers expect" was a belief. These bytes are the evidence.
 *
 * THE EXACT COMMANDS. Run from a phoenix checkout at the commit above, with
 * `$ROOT` a scratch lanes directory outside the repo:
 *
 *     # lane 5673 — a single-issue coder lane, FAIL retry + park/resume, shipped
 *     fabrika lane open       5673 --root $ROOT
 *     fabrika lane transition 5673 WIP       --root $ROOT   # queued → build
 *     fabrika lane transition 5673 DONE      --root $ROOT   # build  → review
 *     fabrika lane transition 5673 FAIL      --root $ROOT   # review → build   (retry 1/2)
 *     fabrika lane transition 5673 DONE      --root $ROOT   # build  → review
 *     fabrika lane transition 5673 PASS      --root $ROOT   # review → ship
 *     fabrika lane transition 5673 BLOCKED   --root $ROOT   # ship   → human:cp-approval
 *     fabrika lane transition 5673 UNBLOCKED --root $ROOT   # park   → ship   (history resume)
 *     fabrika lane transition 5673 DONE      --root $ROOT   # ship   → shipped, workflow → complete
 *
 *     # lane 5674 — the same template driven to the ERROR ending
 *     fabrika lane open       5674 --root $ROOT
 *     fabrika lane transition 5674 WIP  --root $ROOT
 *     fabrika lane transition 5674 DONE --root $ROOT
 *     fabrika lane transition 5674 FAIL --root $ROOT        # retry 1/2
 *     fabrika lane transition 5674 DONE --root $ROOT
 *     fabrika lane transition 5674 FAIL --root $ROOT        # retry 2/2
 *     fabrika lane transition 5674 DONE --root $ROOT
 *     fabrika lane transition 5674 FAIL --root $ROOT        # budget spent → frozen → tripped
 *
 *     # lane 4195 — a FOUR-phase epic machine, emitted from board topology
 *     fabrika lane emit 4195 --root $ROOT --repo kamp-us/phoenix
 *     for t in issue_4239 issue_4253; do
 *       for e in WIP DONE PASS DONE; do
 *         fabrika lane transition 4195 $e --task $t --root $ROOT
 *       done
 *     done                                                  # phase1 → phase2
 *     fabrika lane transition 4195 WIP     --task issue_4240 --root $ROOT
 *     fabrika lane transition 4195 DONE    --task issue_4240 --root $ROOT
 *     fabrika lane transition 4195 BLOCKED --task issue_4241 --root $ROOT
 *
 *     # the four artifacts captured per lane, stderr discarded (it is the
 *     # progress line; stdout is the answer)
 *     cp $ROOT/<n>/workflow.json  <n>.workflow.json
 *     cp $ROOT/<n>/events.jsonl   <n>.events.jsonl
 *     fabrika lane status  <n> --root $ROOT 2>/dev/null > <n>.status.stdout.json
 *     fabrika lane history <n> --root $ROOT 2>/dev/null > <n>.history.stdout.json
 *
 * THE ONE SUBSTITUTION, named. `lane emit` reads the epic's GitHub body and its
 * native sub-issue list through `gh api`. Both reads were served from bytes
 * captured read-only from the live board (`gh api repos/kamp-us/phoenix/issues/4195`
 * and `.../sub_issues?per_page=100`) by a `gh` stand-in first on `PATH`, and the
 * body's `## Dependencies` section was transcribed from the `### Phase N` prose
 * phoenix's `plan-epic` actually renders into the `- phase N: #a, #b` grammar
 * `emit.ts`'s own parser reads — the two disagree upstream (phoenix #5220), so
 * NO open phoenix epic emits today. The phase structure and every issue number
 * are the real ones; nothing was written to GitHub.
 *
 * Kept out of biome (see `biome.jsonc`) so the bytes stay the binary's.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the bytes are, joined with `node:path` rather than with `new URL`.
 *
 * `new URL(relative, import.meta.url)` reads the ENVIRONMENT's `URL`, and a DOM
 * environment installs its own — under happy-dom it resolves a `file:` base to
 * a document-relative path, and the read then misses by the whole repo root. A
 * path join has no such global to be swapped out from under it, and these bytes
 * are read by a component test as well as by a node one.
 */
const DIR = join(dirname(fileURLToPath(import.meta.url)), "real");

const read = (name: string): string =>
  readFileSync(join(DIR, name), { encoding: "utf8" });

/** One lane, as the four artifacts a reader can actually be handed. */
export interface RealLane {
  /** The lane key — the phoenix issue number the lane drives. */
  readonly lane: string;
  /** What was driven, for the test's own name. */
  readonly what: string;
  /** `<lane>/workflow.json`, on disk. */
  readonly workflowJson: string;
  /** `<lane>/events.jsonl`, on disk. */
  readonly eventsJsonl: string;
  /** `fabrika lane status <lane>` — stdout, verbatim. */
  readonly statusStdout: string;
  /** `fabrika lane history <lane>` — stdout, verbatim. */
  readonly historyStdout: string;
}

const lane = (key: string, what: string): RealLane => ({
  lane: key,
  what,
  workflowJson: read(`${key}.workflow.json`),
  eventsJsonl: read(`${key}.events.jsonl`),
  statusStdout: read(`${key}.status.stdout.json`),
  historyStdout: read(`${key}.history.stdout.json`),
});

/** The single-issue coder lane: a FAIL retry, a park, a resume, shipped. */
export const REAL_CODER = lane(
  "5673",
  "coder lane, retry + park/resume, shipped",
);

/** The same template driven past its retry budget: frozen, so the lane trips. */
export const REAL_FROZEN = lane("5674", "coder lane driven to frozen/tripped");

/** A four-phase epic machine `lane emit` generated, advanced one whole phase. */
export const REAL_EPIC = lane(
  "4195",
  "epic lane, phase 1 complete, phase 2 running",
);

export const REAL_LANES = [REAL_CODER, REAL_FROZEN, REAL_EPIC] as const;
