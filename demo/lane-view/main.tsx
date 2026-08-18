// The viewer. One page, every lane on disk, nothing to configure.
//
// `.fabrika/` is gitignored — a lane exists only on the machine that ran it —
// so this reads the disk where it is started and renders in the browser. No
// server, no upload, no copy of a lane leaving the machine.
import mermaid from "mermaid";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { LaneView } from "../../src/chart/lane/react";
import "../../src/chart/lane/styles.css";
import "./style.css";
// @ts-expect-error — supplied by the vite plugin beside this file.
import { LANES, SOURCE } from "virtual:lanes";
import { laneView, replayFeed } from "../../src/chart/lane/view";
import { parseEventsJsonl } from "../../src/chart/report/fold";
import { chartFromWorkflowText } from "../../src/chart/report/workflow";
import { byAttention, type FleetRow, fleetRow } from "./fleet";
import { FABRIKA_ORIGINS } from "./origins";

mermaid.initialize({ startOnLoad: false, theme: "dark" });

type Lane = {
  id: string;
  workflow: string;
  events: string;
  origins?: unknown;
};

/**
 * LIVE — the lanes, as they are on disk right now.
 *
 * An agent driving a lane appends to `events.jsonl`, so the file IS the
 * heartbeat: the dev server watches the lane root and pushes the bytes down
 * the socket it already holds open. Nothing polls, nothing is subscribed to,
 * and the page never reloads — a reload would lose the lane you have open and
 * the step you scrubbed to, which on a screen you leave up all day is the
 * whole value of it.
 */
function useLanes(): { lanes: Lane[]; beat: number } {
  const [lanes, setLanes] = useState(LANES as Lane[]);
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const hot = import.meta.hot;
    if (hot === undefined) return;
    const on = (next: Lane[]) => {
      setLanes(next);
      setBeat((n) => n + 1);
    };
    hot.on("lanes:update", on);
    return () => hot.off("lanes:update", on);
  }, []);
  return { lanes, beat };
}

/**
 * Every mermaid host skips a node once it has drawn it, and the component keys
 * each `<pre>` by its diagram text — so a changed drawing arrives as a NEW
 * node. Watching the DOM is what picks that up; rendering once on mount shows
 * the source from the second frame on.
 */
function Mermaid() {
  useEffect(() => {
    const paint = () => {
      const nodes = document.querySelectorAll<HTMLElement>(
        "pre.mermaid:not([data-processed])",
      );
      if (nodes.length > 0) void mermaid.run({ nodes: [...nodes] });
    };
    paint();
    const obs = new MutationObserver(paint);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
  return null;
}

const ATTENTION_LABEL: Record<string, string> = {
  "needs-you": "needs you",
  tripped: "tripped",
  quiet: "gone quiet",
  moving: "moving",
  unstarted: "not started",
  done: "done",
};

/** The fleet, derived once — every lane read the same way one lane is read. */
function useFleet(
  lanes: Lane[],
  beat: number,
): { row: FleetRow; lane: Lane }[] {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `beat` is the
  // clock — a lane that has been quiet for 20 minutes should say 21 without
  // anything on disk changing, and the tick is what re-derives the ages.
  return useMemo(() => {
    const now = Date.now();
    return lanes
      .map((l) => {
        const chart = chartFromWorkflowText(
          l.workflow,
          (l.origins as typeof FABRIKA_ORIGINS) ?? FABRIKA_ORIGINS,
        );
        const log = parseEventsJsonl(l.events);
        const view = laneView(replayFeed(chart, log), Number.MAX_SAFE_INTEGER);
        const last = log.at(-1)?.at ?? null;
        return { row: fleetRow(l.id, view, last, now), lane: l };
      })
      .sort((a, b) => byAttention(a.row, b.row));
  }, [lanes, beat]);
}

function Fleet({
  lanes,
  beat,
  onOpen,
}: {
  lanes: Lane[];
  beat: number;
  onOpen: (id: string) => void;
}) {
  const fleet = useFleet(lanes, beat);
  const counts = new Map<string, number>();
  for (const { row } of fleet)
    counts.set(row.attention, (counts.get(row.attention) ?? 0) + 1);

  const needs = counts.get("needs-you") ?? 0;

  return (
    <main className="fl">
      <h1 className="fl-h1">
        {needs === 0
          ? "Nothing is waiting on you."
          : `${needs} lane${needs === 1 ? "" : "s"} waiting on you.`}
      </h1>

      <div className="fl-counts">
        {[...counts].map(([k, n]) => (
          <span key={k} className={`fl-chip is-${k}`}>
            <b>{n}</b> {ATTENTION_LABEL[k]}
          </span>
        ))}
      </div>

      <ul className="fl-rows">
        {fleet.map(({ row }) => (
          <li key={row.id}>
            <button
              type="button"
              className={`fl-row is-${row.attention}`}
              onClick={() => onOpen(row.id)}
            >
              <span className="fl-id">{row.id}</span>
              <span className="fl-head">{row.headline}</span>
              <span className="fl-meta">
                {[
                  row.progress,
                  row.quietFor === null ? null : age(row.quietFor),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="fl-foot">
        Read from <code>{SOURCE}</code> — nothing left this machine.
      </p>
    </main>
  );
}

/** Minutes are how the ledger counts; a reader does not think in 1211 of them. */
function age(min: number): string {
  if (min < 60) return `${min}m quiet`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h}h quiet` : `${Math.round(h / 24)}d quiet`;
}

function App() {
  const [open, setOpen] = useState<string | null>(null);
  const { lanes, beat } = useLanes();
  const [tick, setTick] = useState(0);

  // "20h quiet" must not still say 20h an hour later. A minute is finer than
  // anything the ages are rendered in, so nothing on screen is ever stale by
  // more than the unit it is displayed in.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  if (lanes.length === 0) {
    return (
      <main className="lv-empty">
        <h1>No lanes found</h1>
        <p>
          Looked in <code>{SOURCE}</code>.
        </p>
        <p>
          A lane is a directory holding <code>workflow.json</code> and{" "}
          <code>events.jsonl</code>. Point the viewer at one, or at the parent
          holding several:
        </p>
        <pre>LANE_DIR=~/phoenix/.fabrika/lanes pnpm lane:view</pre>
      </main>
    );
  }

  if (open === null)
    return (
      <>
        <Fleet lanes={lanes} beat={beat + tick} onOpen={setOpen} />
        <Mermaid />
      </>
    );

  const lane = lanes.find((l) => l.id === open);
  if (lane === undefined) {
    // the lane went away under us — a root re-pointed, a dir removed.
    setOpen(null);
    return null;
  }
  return (
    <>
      <header className="lv-bar">
        <button type="button" className="lv-back" onClick={() => setOpen(null)}>
          ← all lanes
        </button>
        <nav>
          {lanes.map((l) => (
            <button
              type="button"
              key={l.id}
              className={l.id === open ? "on" : ""}
              onClick={() => setOpen(l.id)}
            >
              {l.id}
            </button>
          ))}
        </nav>
        <code className="lv-src">{SOURCE}</code>
      </header>
      <main>
        <LaneView
          key={lane.id}
          lane={chartFromWorkflowText(
            lane.workflow,
            (lane.origins as typeof FABRIKA_ORIGINS) ?? FABRIKA_ORIGINS,
          )}
          log={parseEventsJsonl(lane.events)}
          title={lane.id}
        />
      </main>
      <Mermaid />
    </>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
