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
        // the flat fixture spelling (`5673.workflow.json`) as well as the
        // on-disk one (`5673/workflow.json`), so `pnpm lane:view` with no
        // argument shows three real lanes and proves the thing works.
        let lanes: Lane[] = [];
        try {
          lanes = collect(target);
        } catch {
          lanes = [];
        }
        if (lanes.length === 0) {
          const names = new Set(
            readdirSync(target)
              .filter((n) => n.endsWith(".workflow.json"))
              .map((n) => n.replace(".workflow.json", "")),
          );
          lanes = [...names].map((id) => ({
            id,
            workflow: readFileSync(join(target, `${id}.workflow.json`), "utf8"),
            events: readFileSync(join(target, `${id}.events.jsonl`), "utf8"),
          }));
        }
        return `export const LANES = ${JSON.stringify(lanes)};
export const SOURCE = ${JSON.stringify(target)};`;
      },
    },
  ],
});
