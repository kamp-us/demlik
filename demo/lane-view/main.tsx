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
import {
  chartFromWorkflowText,
  statesOf,
} from "../../src/chart/report/workflow";
import {
  type DispatchResult,
  explainExit,
  OPERATOR_EVENTS,
  type OperatorEvent,
  send,
} from "./dispatch";
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
type Driver = { session: string; login: string; at: string | null };

/**
 * Ownership, polled — it lives on GitHub, not in the two files, so it cannot
 * ride the file watcher. Absent means UNKNOWN and renders as nothing; a lane
 * shown as free when someone holds it is how two drivers end up on one epic.
 */
function useDrivers(): Record<string, Driver | null> {
  const [drivers, setDrivers] = useState<Record<string, Driver | null>>({});
  useEffect(() => {
    let alive = true;
    const pull = () =>
      fetch("/__lane/drivers")
        .then((r) => r.json())
        .then((d: { drivers: Record<string, Driver | null> }) => {
          if (alive) setDrivers(d.drivers ?? {});
        })
        .catch(() => {});
    pull();
    const t = setInterval(pull, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return drivers;
}

/** `lane:<session>:<uuid>` — a reader needs the person and a short handle. */
function driverLabel(d: Driver): string {
  const short = d.session.split(":")[1]?.slice(0, 7) ?? "";
  return `${d.login} · ${short}`;
}

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
  const drivers = useDrivers();
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
                {drivers[row.id] != null ? (
                  <span className="fl-drv" title={drivers[row.id]?.session}>
                    {driverLabel(drivers[row.id] as Driver)}
                  </span>
                ) : null}
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

/**
 * SENDING AN EVENT, from the screen you noticed the problem on.
 *
 * Only the events the machine DECLARES out of a task's current state are
 * offered. `lane transition` would refuse the rest anyway — but a button that
 * exists to be refused teaches the reader nothing, and one that is absent says
 * "not from here" without costing them a click and an error.
 *
 * fabrika still has the last word: the button proposes, the verb decides, and
 * the log only moves if the machine accepted it.
 */
function Act({
  laneId,
  tasks,
  single,
}: {
  laneId: string;
  /** Each task with the state it is standing in AND its own region — a lane
   *  holds one chart per task, and the events on offer are that chart's. */
  tasks: readonly {
    task: string;
    state: string;
    events: readonly OperatorEvent[];
  }[];
  single: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{
    key: string;
    text: string;
    ok: boolean;
  } | null>(null);

  const fire = async (task: string, event: OperatorEvent) => {
    const key = `${task}.${event}`;
    setBusy(key);
    setSaid(null);
    let out: DispatchResult;
    try {
      out = await send({
        lane: laneId,
        event,
        ...(single ? {} : { task }),
      });
    } catch (e) {
      out = { ok: false, exit: -1, stdout: "", stderr: String(e) };
    }
    setBusy(null);
    setSaid({ key, ok: out.ok, text: explainExit(out.exit, out.stderr) });
    // nothing else to do — if it landed, fabrika appended, the watcher fired
    // and the lanes are already on their way back down the socket.
  };

  const rows = tasks.filter((t) => t.events.length > 0);

  if (rows.length === 0) return null;

  return (
    <section className="act">
      <h3 className="act-h">
        Send an event
        <span className="act-sub">
          fabrika records it, or refuses it and says why
        </span>
      </h3>
      {rows.map((t) => (
        <div className="act-row" key={t.task}>
          <span className="act-task">
            {t.task} <span className="act-at">at {t.state}</span>
          </span>
          <span className="act-btns">
            {t.events.map((e) => {
              const key = `${t.task}.${e}`;
              return (
                <button
                  type="button"
                  key={e}
                  className="act-btn"
                  disabled={busy !== null}
                  onClick={() => void fire(t.task, e)}
                >
                  {busy === key ? "…" : e}
                </button>
              );
            })}
          </span>
          {said !== null && said.key.startsWith(`${t.task}.`) ? (
            <span className={said.ok ? "act-said ok" : "act-said no"}>
              {said.ok ? `${said.key.split(".")[1]} recorded` : said.text}
            </span>
          ) : null}
        </div>
      ))}
    </section>
  );
}

/** The active phase's tasks, which are the only ones an event can address. */
function ActFor({ lane }: { lane: Lane }) {
  const chart = chartFromWorkflowText(
    lane.workflow,
    (lane.origins as typeof FABRIKA_ORIGINS) ?? FABRIKA_ORIGINS,
  );
  const view = laneView(
    replayFeed(chart, parseEventsJsonl(lane.events)),
    Number.MAX_SAFE_INTEGER,
  );
  const phase = view.phases.find((p) => p.name === view.activePhase);
  if (phase === undefined) return null;

  // A lane holds ONE CHART PER TASK, so the events on offer are that task's
  // own region's — asking the lane would be asking the wrong thing, and on a
  // mixed epic the answer would be another task's alphabet.
  const tasks = phase.tasks.map((t) => {
    const region = chart.charts[t.task];
    const on =
      region === undefined ? {} : (statesOf(region).get(t.state)?.on ?? {});
    return {
      task: t.task,
      state: t.state,
      events: OPERATOR_EVENTS.filter((e) => on[e] !== undefined),
    };
  });
  return <Act laneId={lane.id} tasks={tasks} single={tasks.length === 1} />;
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
        <ActFor lane={lane} />
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
