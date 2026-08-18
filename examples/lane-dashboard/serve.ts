// A HOST, END TO END — what a consumer writes to get the dashboard.
//
// This is the whole adapter. It knows three things the library cannot: where
// its lanes are, how it records an event, and who holds a lane. Everything a
// reader sees — the attention ordering, what is stuck and why, the diagrams,
// the scrubbing — comes from the package.
//
// fabrika's version of this file is the same shape with its own verbs in place
// of the shell-outs: `lane transition` called directly rather than spawned,
// and its claim reader in place of `gh`.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type LaneFiles,
  laneViewer,
  type TransitionRequest,
} from "@demlik/tea/chart/lane/server";

const run = promisify(execFile);

const ROOT = process.env.LANE_DIR ?? ".fabrika/lanes";
const PORT = Number(process.env.PORT ?? 5411);
/** How this host records an event — the ONE writer. */
const FABRIKA = (process.env.FABRIKA_BIN ?? "fabrika").split(" ");
const CWD = process.env.FABRIKA_CWD ?? process.cwd();

/** WHERE THE LANES ARE. Two files per directory; that is the whole contract. */
const lanes = (): LaneFiles[] => {
  const read = (dir: string, id: string): LaneFiles | null => {
    try {
      return {
        id,
        workflow: readFileSync(join(dir, "workflow.json"), "utf8"),
        events: (() => {
          try {
            return readFileSync(join(dir, "events.jsonl"), "utf8");
          } catch {
            return ""; // emitted, never run — a real state, not an error
          }
        })(),
        origins: ORIGINS,
      };
    } catch {
      return null;
    }
  };
  return readdirSync(ROOT)
    .map((n) => ({ n, p: join(ROOT, n) }))
    .filter(({ p }) => statSync(p).isDirectory())
    .map(({ n, p }) => read(p, n))
    .filter((l): l is LaneFiles => l !== null);
};

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

/** HOW AN EVENT IS RECORDED. The machine decides; we relay what it said. */
const transition = async (req: TransitionRequest) => {
  const [bin, ...lead] = FABRIKA;
  try {
    const { stdout } = await run(
      bin as string,
      [
        ...lead,
        "lane",
        "transition",
        req.lane,
        req.event,
        "--root",
        ROOT,
        ...(req.task === undefined ? [] : ["--task", req.task]),
      ],
      { cwd: CWD },
    );
    return { ok: true, message: stdout.trim() || `${req.event} recorded` };
  } catch (e) {
    // A refusal is an ANSWER — the machine said no, and it said why. Passing
    // its own words through beats anything this file could invent.
    const err = e as { stderr?: string; message?: string };
    return { ok: false, message: (err.stderr ?? err.message ?? "").trim() };
  }
};

const handle = laneViewer({ lanes, transition, source: ROOT });

createServer(async (req, res) => {
  const request = new Request(`http://localhost:${PORT}${req.url ?? "/"}`, {
    method: req.method,
    ...(req.method === "POST"
      ? {
          body: await new Promise<string>((ok) => {
            let b = "";
            req.on("data", (c) => {
              b += c;
            });
            req.on("end", () => ok(b));
          }),
        }
      : {}),
  });
  const out = await handle(request);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  if (out.body === null) return res.end();
  // stream it, so `/api/stream` stays open rather than being buffered
  const reader = out.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}).listen(PORT, () => console.log(`lanes → http://localhost:${PORT}`));
