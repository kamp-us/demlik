import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * A lane is TWO FILES on disk, and `.fabrika/` is gitignored — the lanes only
 * ever exist on the machine that ran them. So the viewer reads the disk at dev
 * time and hands the bytes to the page; there is no server, no upload and no
 * copy of anyone's lane anywhere.
 */
const VIRTUAL = "virtual:lanes";
/** The one channel the page listens on. */
const CHANNEL = "lanes:update";

/**
 * How to run fabrika. Its own repo runs it off source; an installed one is on
 * PATH. Neither is guessable, so it is configurable and the default is the
 * spelling `operate` itself uses.
 */
const FABRIKA = (
  process.env.FABRIKA_BIN ?? "node packages/fabrika-cli/src/bin.ts"
).split(" ");

/**
 * Where to run it FROM.
 *
 * fabrika refuses to run when the copy you invoked and your cwd are in
 * different repositories — "delegating would have answered from a repository
 * you did not name". That refusal is right, and it means the viewer cannot
 * just inherit its own cwd when it is pointed at another checkout's lanes.
 */
const FABRIKA_CWD = process.env.FABRIKA_CWD ?? process.cwd();

/**
 * WHO IS DRIVING — the one question the two files cannot answer.
 *
 * `lane/claim.ts` is explicit about it: "the ledger is untouched. Claims live
 * on GitHub; nothing here writes events.jsonl, and no claim state is derivable
 * from a fold." So ownership is a THIRD source, read over the network, and
 * everything about this is built to degrade: no `gh`, no auth, no network, or
 * a chore lane with no board thread to race on — each answers "unknown", never
 * "unclaimed". Reporting a held lane as free is the one wrong answer here,
 * because it is the answer that gets a second driver started.
 */
const CLAIM_RE = /^lane-claim:\s*(lane:[^\s·]+)\s*(?:·\s*(.*))?$/m;
const CLAIM_TTL_MS = 60_000;
const BOARD_NUMBER = /^[1-9][0-9]*$/;

type Driver = { session: string; login: string; at: string | null };
let claimCache: { at: number; drivers: Record<string, Driver | null> } | null =
  null;

function gh(args: readonly string[]): Promise<string> {
  return new Promise((ok, no) => {
    // from the repo whose lanes these are — `{owner}/{repo}` resolves off the
    // cwd, and the viewer's own cwd is not that repo when LANE_DIR points out.
    execFile(
      "gh",
      [...args],
      { cwd: FABRIKA_CWD, timeout: 20_000 },
      (err, stdout) => (err === null ? ok(stdout) : no(err)),
    );
  });
}

async function readDrivers(
  ids: readonly string[],
): Promise<Record<string, Driver | null>> {
  const out: Record<string, Driver | null> = {};
  await Promise.all(
    ids
      .filter((id) => BOARD_NUMBER.test(id))
      .map(async (id) => {
        try {
          const raw = await gh([
            "api",
            `repos/{owner}/{repo}/issues/${id}/comments`,
            "--jq",
            ".[] | {body, login: .user.login, at: .created_at} | @json",
          ]);
          // EARLIEST marker wins, which is the same tiebreak `lane claim` uses —
          // the comment's own created_at, which a claimant cannot author.
          for (const line of raw.split("\n").filter(Boolean)) {
            const c = JSON.parse(line) as {
              body: string;
              login: string;
              at: string;
            };
            const m = CLAIM_RE.exec(c.body ?? "");
            if (m?.[1] !== undefined) {
              out[id] = { session: m[1], login: c.login, at: c.at };
              return;
            }
          }
          out[id] = null;
        } catch {
          // unreadable is UNKNOWN, and UNKNOWN is not "nobody" — leave it absent
          // so the page says nothing rather than says free.
        }
      }),
  );
  return out;
}

/** The operator's six. Anything else never reaches the CLI. */
const EVENTS = new Set(["WIP", "DONE", "PASS", "FAIL", "BLOCKED", "UNBLOCKED"]);

/** A lane key or task name, conservatively. Nothing here reaches a shell. */
const NAME = /^[A-Za-z0-9_.:-]{1,120}$/;

type Lane = {
  id: string;
  workflow: string;
  events: string;
  origins?: unknown;
};

/** An optional `origins.json` beside the lane overrides the viewer's cast. */
function originsIn(d: string): unknown {
  try {
    return JSON.parse(readFileSync(join(d, "origins.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/** One lane dir, or a parent holding several — both spellings work. */
function collect(dir: string): Lane[] {
  const one = (d: string): Lane | null => {
    try {
      return {
        id: d.split("/").filter(Boolean).pop() ?? "lane",
        workflow: readFileSync(join(d, "workflow.json"), "utf8"),
        // a lane that has been emitted but never run has no log yet, and that
        // is a legitimate thing to look at: every task sits where it booted.
        events: (() => {
          try {
            return readFileSync(join(d, "events.jsonl"), "utf8");
          } catch {
            return "";
          }
        })(),
        ...(originsIn(d) === undefined ? {} : { origins: originsIn(d) }),
      };
    } catch {
      return null;
    }
  };

  const self = one(dir);
  if (self !== null) return [self];

  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isDirectory())
    .map(one)
    .filter((l): l is Lane => l !== null);
}

/**
 * Every lane under `dir`, however it is spelled on disk.
 *
 * ONE implementation, because the first paint and every live update must agree
 * — a watcher that re-read differently would show a lane moving that had not.
 */
function readLanes(dir: string): Lane[] {
  let lanes: Lane[] = [];
  try {
    lanes = collect(dir);
  } catch {
    lanes = [];
  }
  if (lanes.length > 0) return lanes;
  // the flat fixture spelling (`5673.workflow.json`) as well as the on-disk
  // one, so `pnpm lane:view` with no argument shows three real lanes and
  // proves the thing works before anyone points it at their own.
  try {
    const names = new Set(
      readdirSync(dir)
        .filter((n) => n.endsWith(".workflow.json"))
        .map((n) => n.replace(".workflow.json", "")),
    );
    return [...names].map((id) => ({
      id,
      workflow: readFileSync(join(dir, `${id}.workflow.json`), "utf8"),
      events: readFileSync(join(dir, `${id}.events.jsonl`), "utf8"),
    }));
  } catch {
    return [];
  }
}

const target = resolve(
  process.env.LANE_DIR ?? "src/chart/report/__fixtures__/real",
);

export default defineConfig({
  root: "demo/lane-view",
  server: { port: 5410, open: true, fs: { allow: [resolve("."), target] } },
  plugins: [
    react(),
    {
      name: "lanes-from-disk",
      resolveId: (id) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
      load(id) {
        if (id !== `\0${VIRTUAL}`) return null;
        const lanes = readLanes(target);
        return `export const LANES = ${JSON.stringify(lanes)};
export const SOURCE = ${JSON.stringify(target)};`;
      },

      // ── LIVE ───────────────────────────────────────────────────────────
      // An agent driving a lane APPENDS to `events.jsonl`, so the file's
      // mtime is the pipeline's own heartbeat — there is nothing to poll and
      // no endpoint to call. Watch the lane root, re-read on any change, and
      // push. A whole-page reload would work and would also throw away
      // whatever the reader was looking at, so the bytes go over the socket
      // and the page swaps them in place: scroll position, the lane you have
      // open and the step you scrubbed to all survive the update.
      configureServer(server) {
        // ── SENDING AN EVENT ────────────────────────────────────────────
        // The page proposes and `lane transition` disposes. Nothing here
        // writes `events.jsonl`: the verb refuses an event the machine has no
        // cell for and leaves the log byte-identical, and re-implementing that
        // refusal on this side would be a second writer with its own rules.
        //
        // `execFile` with an argument ARRAY, never a shell string, and both
        // names re-validated here — this endpoint is reachable by anything
        // that can talk to the dev server.
        server.middlewares.use("/__lane/transition", (req, res, next) => {
          if (req.method !== "POST") return next();
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            const answer = (code: number, payload: unknown) => {
              res.statusCode = code;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify(payload));
            };
            let lane: string;
            let event: string;
            let task: string | undefined;
            try {
              const p = JSON.parse(body) as Record<string, unknown>;
              lane = String(p.lane ?? "");
              event = String(p.event ?? "");
              task = p.task === undefined ? undefined : String(p.task);
            } catch {
              return answer(400, {
                ok: false,
                exit: -1,
                stdout: "",
                stderr: "malformed request",
              });
            }
            if (
              !NAME.test(lane) ||
              !EVENTS.has(event) ||
              (task !== undefined && !NAME.test(task))
            ) {
              return answer(400, {
                ok: false,
                exit: -1,
                stdout: "",
                stderr: "not a lane key, an operator event and a task name",
              });
            }

            const [bin, ...lead] = FABRIKA;
            const args = [
              ...lead,
              "lane",
              "transition",
              lane,
              event,
              "--root",
              target,
              ...(task === undefined ? [] : ["--task", task]),
            ];
            execFile(
              bin as string,
              args,
              { cwd: FABRIKA_CWD, timeout: 60_000 },
              (err, stdout, stderr) => {
                const exit =
                  err === null
                    ? 0
                    : typeof (err as { code?: unknown }).code === "number"
                      ? ((err as { code: number }).code as number)
                      : 1;
                answer(200, { ok: exit === 0, exit, stdout, stderr });
              },
            );
          });
        });

        // ── WHO IS DRIVING ──────────────────────────────────────────────
        server.middlewares.use("/__lane/drivers", (req, res, next) => {
          if (req.method !== "GET") return next();
          const done = (drivers: Record<string, Driver | null>) => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ drivers }));
          };
          const now = Date.now();
          if (claimCache !== null && now - claimCache.at < CLAIM_TTL_MS) {
            return done(claimCache.drivers);
          }
          void readDrivers(readLanes(target).map((l) => l.id))
            .then((drivers) => {
              claimCache = { at: Date.now(), drivers };
              done(drivers);
            })
            .catch(() => done({}));
        });

        server.watcher.add(target);
        const push = (path: string) => {
          if (!path.startsWith(target)) return;
          try {
            server.ws.send({
              type: "custom",
              event: CHANNEL,
              data: readLanes(target),
            });
          } catch {
            // a half-written file during an append is not an error, it is the
            // next event arriving — the following change fires with it whole.
          }
        };
        server.watcher.on("add", push);
        server.watcher.on("change", push);
        server.watcher.on("unlink", push);
        server.watcher.on("addDir", push);
      },
    },
  ],
});
