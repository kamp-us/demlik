// A HOST, END TO END.
//
// Two facts a library cannot know: where your lanes are, and how you record an
// event. Everything else — reading the two files each lane is, serving the
// page, keeping it current, the attention ordering, what is stuck and why, the
// diagrams, the scrubbing — comes from `@demlik/tea`.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  serveLaneViewer,
  type TransitionRequest,
} from "@demlik/tea/chart/lane/server";

const run = promisify(execFile);

const ROOT = process.env.LANE_DIR ?? ".fabrika/lanes";
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
