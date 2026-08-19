// The viewer. One page, every lane on disk, nothing to configure.
//
// `.fabrika/` is gitignored — a lane exists only on the machine that ran it —
// so this reads the disk where it is started and renders in the browser. No
// server, no upload, no copy of a lane leaving the machine.
import mermaid from "mermaid";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { LaneView } from "../../src/chart/lane/react";
import "../../src/chart/lane/styles.css";
import "./style.css";
// @ts-expect-error — supplied by the vite plugin beside this file.
import { LANES, SOURCE } from "virtual:lanes";
import {
  type LaneViewModel,
  laneView,
  replayFeed,
} from "../../src/chart/lane/view";
import { parseEventsJsonl } from "../../src/chart/report/fold";
import {
  chartFromWorkflowText,
  type ImportedLane,
  statesOf,
} from "../../src/chart/report/workflow";
import {
  type DispatchResult,
  explainExit,
  OPERATOR_EVENTS,
  type OperatorEvent,
  send,
} from "./dispatch";
import { byAttention, type FleetRow, fleetRow, unreadableRow } from "./fleet";
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
function useLanes(): { lanes: Lane[]; beat: number; source: string } {
  const [lanes, setLanes] = useState(LANES as Lane[]);
  const [beat, setBeat] = useState(0);
  const [source, setSource] = useState(SOURCE as string);
  const arrived = useCallback((next: Lane[]) => {
    setLanes(next);
    setBeat((n) => n + 1);
  }, []);

  useEffect(() => {
    // TWO HOSTS, ONE PAGE. Under `pnpm lane:view` the lanes come off disk at
    // build time and updates ride vite's own socket. Served by a consumer —
    // fabrika, or anything else implementing the contract — they come from
    // `/api/lanes` and updates from `/api/stream`. Neither knows about the
    // other; the page just takes whichever answers.
    const hot = import.meta.hot;
    if (hot !== undefined) {
      hot.on("lanes:update", arrived);
      return () => hot.off("lanes:update", arrived);
    }

    let alive = true;
    void fetch("/api/lanes")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { lanes?: Lane[]; source?: string } | null) => {
        if (!alive || d?.lanes === undefined) return;
        arrived(d.lanes);
        if (typeof d.source === "string") setSource(d.source);
      })
      .catch(() => {});

    const es = new EventSource("/api/stream");
    es.onmessage = (e) => {
      try {
        arrived(JSON.parse(e.data as string) as Lane[]);
      } catch {
        // a partial frame is the next event still arriving
      }
    };
    return () => {
      alive = false;
      es.close();
    };
  }, [arrived]);
  return { lanes, beat, source };
}

/**
 * Every mermaid host skips a node once it has drawn it, and the component keys
 * each `<pre>` by its diagram text — so a changed drawing arrives as a NEW
 * node. Watching the DOM is what picks that up; rendering once on mount shows
 * the source from the second frame on.
 *
 * SCRUBBING IS THE HARD CASE. Stepping through the log changes the diagram on
 * every press, and each change is a fresh `<pre>` holding raw mermaid source
 * that mermaid has not replaced with an svg yet. Left alone the reader sees the
 * source text flash, then the panel collapse to nothing, then snap back to a
 * diagram's height — three times a second while they hold the key down.
 *
 * So the node is hidden until it is drawn (the stylesheet does that), and the
 * space it will occupy is held open here: the height each task's diagram last
 * rendered at is remembered, and the replacement is floored to it before
 * mermaid runs. The diagram still redraws — it just stops moving the page.
 */
const DREW_AT = new Map<string, number>();

/** Which task's diagram this is, so its height is remembered as its own. */
const taskOf = (n: HTMLElement): string =>
  n.closest<HTMLElement>("[data-task]")?.dataset.task ?? "";

function Mermaid() {
  useEffect(() => {
    const paint = () => {
      const nodes = document.querySelectorAll<HTMLElement>(
        "pre.mermaid:not([data-processed])",
      );
      if (nodes.length === 0) return;
      for (const n of nodes) {
        const was = DREW_AT.get(taskOf(n));
        if (was !== undefined) n.style.minHeight = `${was}px`;
      }
      void mermaid.run({ nodes: [...nodes] }).then(() => {
        for (const n of nodes) {
          // The SVG's height, not the node's — the node's includes the floor
          // we just put under it, so remembering that would ratchet: every
          // redraw would hold open the tallest the diagram has ever been and
          // a lane that shed a phase would keep the empty space forever.
          const h = n.querySelector("svg")?.getBoundingClientRect().height ?? 0;
          if (h > 0) DREW_AT.set(taskOf(n), h);
          // Drawn — the diagram sets its own height from here.
          n.style.minHeight = "";
        }
      });
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
  unreadable: "unreadable",
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
      fetch("/api/drivers")
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

/**
 * READING A LANE, ONCE, AND SURVIVING A LANE THAT WILL NOT READ.
 *
 * `workflow.json` is written by whatever emitted the lane, so it can be
 * half-written, hand-edited or from a version this viewer does not understand.
 * Parsing it inside render meant one bad file threw during React's commit and
 * took the WHOLE screen with it: eleven healthy lanes went blank because of a
 * twelfth, which is the exact opposite of what a fleet screen is for.
 *
 * So the parse happens here, once per lane, and its failure is a value.
 */
type Read =
  | {
      readonly ok: true;
      readonly chart: ImportedLane;
      readonly view: LaneViewModel;
    }
  | { readonly ok: false; readonly why: string };

function readLane(l: Lane, at: number): Read {
  try {
    const chart = chartFromWorkflowText(
      l.workflow,
      (l.origins as typeof FABRIKA_ORIGINS) ?? FABRIKA_ORIGINS,
    );
    const log = parseEventsJsonl(l.events);
    return { ok: true, chart, view: laneView(replayFeed(chart, log), at) };
  } catch (e) {
    // The parser's own sentence, trimmed of the prefix that names this
    // library — the reader knows which viewer they are looking at.
    const why = (e instanceof Error ? e.message : String(e)).replace(
      /^@demlik\/tea:\s*/,
      "",
    );
    return { ok: false, why };
  }
}

type Seat = { row: FleetRow; lane: Lane; read: Read };

function useFleet(lanes: Lane[], beat: number): Seat[] {
  // `beat` is the clock: a lane quiet for 20 minutes should read 21 without
  // anything on disk changing, and the tick is what re-derives the ages. It is
  // a dependency in the honest sense — the answer is a function of it.
  return useMemo(() => {
    const now = Date.now();
    void beat;
    return lanes
      .map((l) => {
        const read = readLane(l, Number.MAX_SAFE_INTEGER);
        if (!read.ok)
          return { row: unreadableRow(l.id, read.why), lane: l, read };
        const last = parseEventsJsonl(l.events).at(-1)?.at ?? null;
        return { row: fleetRow(l.id, read.view, last, now), lane: l, read };
      })
      .sort((a, b) => byAttention(a.row, b.row));
  }, [lanes, beat]);
}

/**
 * THE RAIL — every lane, always, whichever one you have open.
 *
 * The first cut of this screen was two screens: a list, and a lane you
 * reached by leaving the list. That is a document's shape, not a console's.
 * An operator watching a fleet needs the fleet in view WHILE they work one
 * lane, because the reason to look away is another lane going amber, and a
 * list you have navigated away from cannot tell you that.
 */
function Rail({
  fleet,
  drivers,
  open,
  onOpen,
}: {
  fleet: readonly { row: FleetRow }[];
  drivers: Record<string, Driver | null>;
  open: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <nav className="rail" aria-label="lanes">
      <ul className="rail-rows">
        {fleet.map(({ row }) => (
          <li key={row.id}>
            <button
              type="button"
              className={`rail-row is-${row.attention}${row.id === open ? " on" : ""}`}
              aria-current={row.id === open ? "true" : undefined}
              onClick={() => onOpen(row.id)}
            >
              <span className="rail-top">
                <span className="rail-id">{row.id}</span>
                {drivers[row.id] != null ? (
                  <span className="rail-drv" title={drivers[row.id]?.session}>
                    {driverLabel(drivers[row.id] as Driver)}
                  </span>
                ) : null}
              </span>
              <span className="rail-head">{row.headline}</span>
              <span className="rail-meta">
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
    </nav>
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
          {said?.key.startsWith(`${t.task}.`) === true ? (
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
function ActFor({
  lane,
  chart,
  view,
}: {
  lane: Lane;
  chart: ImportedLane;
  view: LaneViewModel;
}) {
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

/**
 * A LANE THAT WILL NOT PARSE, said out loud.
 *
 * The rail keeps its row either way, so the stage owes the reader the rest:
 * which file, what the parser objected to, and the one command that shows the
 * bytes. Anything less and the row is a dead end.
 */
function Unreadable({ id, why }: { id: string; why: string }) {
  return (
    <section className="broke">
      <h2 className="broke-h">This lane could not be read</h2>
      <p className="broke-why">{why}</p>
      <p className="broke-p">
        Every other lane on this screen is unaffected — only this one is
        skipped. Its <code>workflow.json</code> is either not valid JSON or not
        a shape this viewer understands.
      </p>
      <pre className="broke-cmd">{`cat ${SOURCE}/${id}/workflow.json | jq .`}</pre>
    </section>
  );
}

/**
 * THE BACKSTOP.
 *
 * `readLane` catches the failure we know about — a workflow that will not
 * parse. This catches the ones we do not: a chart that imports but renders
 * badly, a mermaid diagram that throws, a shape from a future fabrika. React
 * unmounts the whole tree on an uncaught render error, so without a boundary
 * here the blast radius of any of them is still the entire screen.
 *
 * Keyed by lane id at the call site, which is what lets a reader click away to
 * a healthy lane and back rather than being stuck on the wreck.
 */
class Boundary extends Component<
  { id: string; children: ReactNode },
  { why: string | null }
> {
  state: { why: string | null } = { why: null };
  static getDerivedStateFromError(e: unknown) {
    return { why: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return this.state.why === null ? (
      this.props.children
    ) : (
      <Unreadable id={this.props.id} why={this.state.why} />
    );
  }
}

/** The rollup, in a sentence — the one thing worth reading from across a room. */
function Verdict({
  needs,
  tripped,
  broken,
}: {
  needs: number;
  tripped: number;
  broken: number;
}) {
  if (needs > 0)
    return (
      <b className="hd-say is-needs-you">
        {needs} lane{needs === 1 ? "" : "s"} waiting on you
      </b>
    );
  if (tripped > 0)
    return (
      <b className="hd-say is-tripped">
        {tripped} lane{tripped === 1 ? "" : "s"} tripped
      </b>
    );
  // Last, because a file this viewer cannot read is our problem, not the
  // operator's — but it still beats claiming all is well while a lane is dark.
  if (broken > 0)
    return (
      <b className="hd-say is-unreadable">
        {broken} lane{broken === 1 ? "" : "s"} could not be read
      </b>
    );
  return <b className="hd-say">Nothing is waiting on you</b>;
}

function App() {
  const [open, setOpen] = useState<string | null>(null);
  const { lanes, beat, source } = useLanes();
  const [tick, setTick] = useState(0);

  // "20h quiet" must not still say 20h an hour later. A minute is finer than
  // anything the ages are rendered in, so nothing on screen is ever stale by
  // more than the unit it is displayed in.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const fleet = useFleet(lanes, beat + tick);
  const drivers = useDrivers();

  // OPEN ON THE PROBLEM. The rail is sorted by who needs you, so its first row
  // IS the answer to "what should I look at" — landing on a blank stage and
  // making the operator click it would be asking them the question they came
  // here to have answered.
  const shown = open ?? fleet[0]?.row.id ?? null;
  const seat = fleet.find((f) => f.row.id === shown);
  const lane = seat?.lane;

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

  const counts = new Map<string, number>();
  for (const { row } of fleet)
    counts.set(row.attention, (counts.get(row.attention) ?? 0) + 1);

  return (
    <div className="op">
      <header className="hd">
        <span className="hd-brand">fabrika</span>
        <Verdict
          needs={counts.get("needs-you") ?? 0}
          tripped={counts.get("tripped") ?? 0}
          broken={counts.get("unreadable") ?? 0}
        />
        <span className="hd-counts">
          {[...counts].map(([k, n]) => (
            <span key={k} className={`hd-chip is-${k}`}>
              <b>{n}</b> {ATTENTION_LABEL[k]}
            </span>
          ))}
        </span>
        <span className="hd-src" title={source}>
          <span className="hd-live" aria-hidden="true" />
          {source || "this machine"}
        </span>
      </header>

      <Rail fleet={fleet} drivers={drivers} open={shown} onOpen={setOpen} />

      <main className="stage">
        {lane === undefined ? null : (
          <>
            <div className="stage-hd">
              <h1>{lane.id}</h1>
              <span className="stage-sub">{seat?.row.headline}</span>
            </div>
            {seat === undefined || !seat.read.ok ? (
              <Unreadable
                id={lane.id}
                why={seat?.read.ok === false ? seat.read.why : "unknown"}
              />
            ) : (
              <Boundary id={lane.id} key={`b-${lane.id}`}>
                <ActFor
                  key={`act-${lane.id}`}
                  lane={lane}
                  chart={seat.read.chart}
                  view={seat.read.view}
                />
                <LaneView
                  key={lane.id}
                  lane={seat.read.chart}
                  log={parseEventsJsonl(lane.events)}
                  title={lane.id}
                />
              </Boundary>
            )}
          </>
        )}
      </main>
      <Mermaid />
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
