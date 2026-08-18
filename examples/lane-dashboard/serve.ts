// A HOST, END TO END — and it is three callbacks, because everything between
// them and a running page belongs to the package.
//
// The three facts a library cannot know: where your lanes are, how you record
// an event, and who holds one. Everything a reader sees — the attention
// ordering, what is stuck and why, the diagrams, the scrubbing, the live
// updates — comes from `@demlik/tea`.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type LaneFiles,
  serveLaneViewer,
  type TransitionRequest,
} from "@demlik/tea/chart/lane/server";

const run = promisify(execFile);

const ROOT = process.env.LANE_DIR ?? ".fabrika/lanes";
const FABRIKA = (process.env.FABRIKA_BIN ?? "fabrika").split(" ");
const CWD = process.env.FABRIKA_CWD ?? process.cwd();

/** WHO SENDS WHAT — the fact a workflow document does not record. */
const ORIGINS = {
  from: {
    WIP: { world: "the operator" },
    BLOCKED: { world: "the operator" },
    UNBLOCKED: { world: "a human" },
    DONE: "cmd",
    PASS: "cmd",
    FAIL: "cmd",
  },
};

/** ① WHERE THE LANES ARE. Two files per directory; that is the whole contract. */
const lanes = (): LaneFiles[] =>
  readdirSync(ROOT)
    .map((name) => ({ name, dir: join(ROOT, name) }))
    .filter(({ dir }) => statSync(dir).isDirectory())
    .flatMap(({ name, dir }) => {
      try {
        return [
          {
            id: name,
            workflow: readFileSync(join(dir, "workflow.json"), "utf8"),
            // emitted and never run is a real state, not an error
            events: (() => {
              try {
                return readFileSync(join(dir, "events.jsonl"), "utf8");
              } catch {
                return "";
              }
            })(),
            origins: ORIGINS,
          },
        ];
      } catch {
        return []; // a scratch directory under the root is not a lane
      }
    });

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

// ③ WHO IS DRIVING would go here, when a host can answer it.

const { url } = await serveLaneViewer({
  lanes,
  transition,
  source: ROOT,
  port: Number(process.env.PORT ?? 5411),
});
console.log(`lanes → ${url}`);
