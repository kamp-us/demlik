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
