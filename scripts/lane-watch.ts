// A HOST, END TO END.
//
// Two facts a library cannot know: where your lanes are, and how you record an
// event. Everything else — reading the two files each lane is, serving the
// page, keeping it current, the attention ordering, what is stuck and why, the
// diagrams, the scrubbing — comes from `@demlik/tea`.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  serveLaneViewer,
  type TransitionRequest,
} from "@demlik/tea/chart/lane/server";

const run = promisify(execFile);

const WORKTREES = ".claude/worktrees";

/**
 * Every lanes root on this machine — this checkout's, and one per agent worktree.
 *
 * `.fabrika/` is gitignored and per-checkout, so an agent driving a lane from a
 * worktree writes its ledger THERE. Watching only `./.fabrika/lanes` from the
 * primary checkout shows an empty board while the work is actually moving one
 * directory over, which reads identically to nothing happening.
 */
const laneRoots = (): readonly string[] => {
  const roots = [".fabrika/lanes"];
  if (existsSync(WORKTREES)) {
    for (const tree of readdirSync(WORKTREES)) {
      roots.push(join(WORKTREES, tree, ".fabrika", "lanes"));
    }
  }
  return roots.filter(existsSync);
};

/** When a root last saw an event, epoch ms. A root with no ledger yet answers 0. */
const lastEventAt = (root: string): number => {
  let newest = 0;
  for (const lane of readdirSync(root)) {
    const log = join(root, lane, "events.jsonl");
    if (existsSync(log)) newest = Math.max(newest, statSync(log).mtimeMs);
  }
  return newest;
};

/**
 * The root to watch. `LANE_DIR` wins outright — an explicit answer is never
 * overridden. Otherwise: whichever root moved most recently, because the one
 * being driven right now is the one worth looking at. Ties go to this checkout,
 * which is what `roots[0]` and a strict `>` give us.
 */
const pickRoot = (): string => {
  const roots = laneRoots();
  if (roots.length === 0) return ".fabrika/lanes";
  let best = roots[0] as string;
  let bestAt = lastEventAt(best);
  for (const root of roots.slice(1)) {
    const at = lastEventAt(root);
    if (at > bestAt) [best, bestAt] = [root, at];
  }
  return best;
};

const ROOT = process.env.LANE_DIR ?? pickRoot();
const FABRIKA = (process.env.FABRIKA_BIN ?? "fabrika").split(" ");
const CWD = process.env.FABRIKA_CWD ?? process.cwd();

/** ② HOW AN EVENT IS RECORDED. The machine decides; we relay what it said. */
const transition = async ({ lane, event, task }: TransitionRequest) => {
  const [bin, ...lead] = FABRIKA;
  try {
    const { stdout } = await run(
      bin as string,
      [
        ...lead,
        "lane",
        "transition",
        lane,
        event,
        "--root",
        ROOT,
        ...(task === undefined ? [] : ["--task", task]),
      ],
      { cwd: CWD },
    );
    return { ok: true, message: stdout.trim() || `${event} recorded` };
  } catch (e) {
    // A refusal is an ANSWER — the machine said no and said why. Its own words
    // beat anything this file could invent.
    const err = e as { stderr?: string; message?: string };
    return { ok: false, message: (err.stderr ?? err.message ?? "").trim() };
  }
};

const { url } = await serveLaneViewer({
  // ① WHERE THE LANES ARE.
  root: ROOT,
  transition,
  // WHO SENDS WHAT — the one fact the documents do not record. Without it the
  // page can see a task cannot move and not that it is waiting on a PERSON.
  origins: {
    from: {
      WIP: { world: "the operator" },
      BLOCKED: { world: "the operator" },
      UNBLOCKED: { world: "a human" },
      DONE: "cmd",
      PASS: "cmd",
      FAIL: "cmd",
    },
  },
  port: Number(process.env.PORT ?? 5411),
});

console.log(`lanes → ${url}`);
console.log(`  reading ${ROOT}`);
// Naming the roads not taken is the whole point: a silent pick is indistinguishable
// from there being nothing else, which is exactly the confusion this resolution exists
// to end. `LANE_DIR=<path> pnpm lane:watch` overrides.
for (const root of laneRoots().filter((r) => r !== ROOT)) {
  console.log(`  also on disk, not watched: ${root}`);
}
