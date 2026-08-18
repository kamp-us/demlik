// The viewer. One page, every lane on disk, nothing to configure.
//
// `.fabrika/` is gitignored — a lane exists only on the machine that ran it —
// so this reads the disk where it is started and renders in the browser. No
// server, no upload, no copy of a lane leaving the machine.
import mermaid from "mermaid";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LaneView } from "../../src/chart/lane/react";
import "../../src/chart/lane/styles.css";
import "./style.css";
// @ts-expect-error — supplied by the vite plugin beside this file.
import { LANES, SOURCE } from "virtual:lanes";
import { parseEventsJsonl } from "../../src/chart/report/fold";
import { chartFromWorkflowText } from "../../src/chart/report/workflow";
import { FABRIKA_ORIGINS } from "./origins";

mermaid.initialize({ startOnLoad: false, theme: "dark" });

type Lane = {
  id: string;
  workflow: string;
  events: string;
  origins?: unknown;
};
const lanes = LANES as Lane[];

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

function App() {
  const [at, setAt] = useState(0);
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
        <pre>pnpm lane:view ~/phoenix/.fabrika/lanes</pre>
      </main>
    );
  }

  const lane = lanes[Math.min(at, lanes.length - 1)] as Lane;
  return (
    <>
      <header className="lv-bar">
        <span className="lv-brand">fabrika lanes</span>
        <nav>
          {lanes.map((l, i) => (
            <button
              type="button"
              key={l.id}
              className={i === at ? "on" : ""}
              onClick={() => setAt(i)}
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
