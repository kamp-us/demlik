// ═══════════════════════════════════════════════════════════════════════════
// chart/lane/server — the dashboard, as something a host can SERVE.
//
// `./chart/lane/react` gives you the components and assumes you have a
// bundler. A CLI does not, and the consumer this was written for — fabrika —
// is a CLI: it already knows where the lanes are, how to fold one and how to
// record an event, and what it does not have is a page.
//
// So this ships the page prebuilt and asks the host for the three facts only
// the host can know:
//
//   WHERE THE LANES ARE — it reads its own root; we never touch a filesystem.
//   HOW TO RECORD AN EVENT — its own verb, which stays the ONLY writer. The
//     page proposes and the host disposes; a refusal is an answer, not an
//     error, and it is displayed in the host's own words.
//   WHO HOLDS A LANE — optional, because ownership is not in the lane files at
//     all (fabrika keeps claims on GitHub), so plenty of hosts cannot answer
//     it. Absent means UNKNOWN and the page says nothing, never "free".
//
// Everything else — folding, deriving what is stuck, drawing the machines,
// the attention ordering, the scrubbing — is the library's and is already
// tested here. The host writes an adapter, not a dashboard.
//
// The handler is `(Request) => Promise<Response>`, so it mounts under Node's
// `http`, Bun.serve, Hono, or a Worker without an adapter per framework.
// ═══════════════════════════════════════════════════════════════════════════
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One lane, as the two files a host already has on disk. */
export interface LaneFiles {
  /** The lane key — the issue number, or whatever the host names lanes by. */
  readonly id: string;
  /** `workflow.json`, verbatim. */
  readonly workflow: string;
  /** `events.jsonl`, verbatim. Empty for a lane that has not run yet. */
  readonly events: string;
  /**
   * Who sends each event, when the host knows.
   *
   * A workflow document records topology and never provenance, so without
   * this the page can see that a task cannot move and not that it is WAITING
   * ON SOMEONE — which is the question a reader opened it to answer.
   */
  readonly origins?: unknown;
}

/** What the host is asked to do when a reader presses a button. */
export interface TransitionRequest {
  readonly lane: string;
  readonly event: string;
  /** Absent on a single-task lane, exactly as the CLI verb allows. */
  readonly task?: string;
}

/**
 * The host's answer. A refusal is a legitimate one — the machine said no —
 * and `message` is shown to the reader verbatim, so write it for them.
 */
export interface TransitionResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Who holds a lane, when the host can say. */
export interface LaneDriver {
  /** A person or account — what a reader recognises. */
  readonly login: string;
  /** The claim token, or any stable handle for the session holding it. */
  readonly session: string;
  readonly at?: string | null;
}

export interface LaneViewerOptions {
  /** Every lane the reader should see. Called on each request; cache if slow. */
  readonly lanes: () => readonly LaneFiles[] | Promise<readonly LaneFiles[]>;
  /**
   * Record one event. OMIT IT and the page becomes read-only — every lane is
   * still shown, and nothing offers to act. That is a real mode, not a
   * degraded one: a report of a run that finished has nothing to dispatch.
   */
  readonly transition?: (
    req: TransitionRequest,
  ) => TransitionResult | Promise<TransitionResult>;
  /** Ownership, when it is knowable. `null` for a lane nobody holds. */
  readonly drivers?: () => Promise<Readonly<Record<string, LaneDriver | null>>>;
  /** Shown in the footer — where these lanes were read from. */
  readonly source?: string;
  /**
   * How often to re-ask `lanes()` for the live stream, in ms. Default 2000.
   *
   * LIVENESS IS OURS, NOT THE HOST'S. A host could watch its own files and
   * push, and then every host would write that code and get it subtly
   * different. Re-asking is uninteresting and correct: `lanes()` is a read of
   * two files a driver appends to, the answer is compared before anything is
   * sent, and a quiet fleet costs one stat per lane per tick.
   */
  readonly pollMs?: number;
}

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Where the prebuilt page lives inside this package. */
const ASSETS = resolve(fileURLToPath(import.meta.url), "..", "viewer");

/**
 * The page, plus the small JSON contract it speaks.
 *
 * ```ts
 * const handle = laneViewer({
 *   lanes: () => readMyLanes(),
 *   transition: (r) => myTransitionVerb(r),
 * });
 * // Node:
 * createServer(async (req, res) => { … await handle(request) … });
 * ```
 */
export function laneViewer(
  opts: LaneViewerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/lanes") {
      return json({ lanes: await opts.lanes(), source: opts.source ?? "" });
    }

    if (path === "/api/drivers") {
      if (opts.drivers === undefined) return json({ drivers: {} });
      try {
        return json({ drivers: await opts.drivers() });
      } catch {
        // UNKNOWN is not "nobody" — an empty answer renders nothing, and a
        // lane shown free while someone holds it is what starts a second
        // driver on one piece of work.
        return json({ drivers: {} });
      }
    }

    if (path === "/api/stream") {
      const every = Math.max(250, opts.pollMs ?? 2000);
      let last = "";
      let timer: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          const beat = async () => {
            try {
              const next = JSON.stringify(await opts.lanes());
              if (next === last) return;
              last = next;
              controller.enqueue(enc.encode(`data: ${next}\n\n`));
            } catch {
              // a half-written append is the next event arriving, not a fault
            }
          };
          void beat();
          timer = setInterval(() => void beat(), every);
        },
        cancel() {
          if (timer !== undefined) clearInterval(timer);
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        },
      });
    }

    if (path === "/api/transition") {
      if (request.method !== "POST") return json({ ok: false }, 405);
      if (opts.transition === undefined) {
        return json(
          {
            ok: false,
            exit: 1,
            stdout: "",
            stderr: "this viewer is read-only",
          },
          200,
        );
      }
      let body: TransitionRequest;
      try {
        body = (await request.json()) as TransitionRequest;
      } catch {
        return json(
          { ok: false, exit: 1, stdout: "", stderr: "malformed request" },
          400,
        );
      }
      const out = await opts.transition(body);
      // the page reads `{ok, exit, stdout, stderr}` — a host that speaks in
      // sentences rather than exit codes says the same thing in `stderr`.
      return json({
        ok: out.ok,
        exit: out.ok ? 0 : 1,
        stdout: out.ok ? out.message : "",
        stderr: out.ok ? "" : out.message,
      });
    }

    // ── the page itself ────────────────────────────────────────────────
    // Anything that is not the contract is an asset, and anything that is
    // not an asset is the page — a dashboard is one screen, so an unknown
    // path is a reader who typed something, not a 404 worth showing them.
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    const file = normalize(join(ASSETS, rel));
    if (!file.startsWith(ASSETS)) return new Response("no", { status: 403 });

    try {
      const bytes = await readFile(file);
      return new Response(new Uint8Array(bytes), {
        headers: {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
        },
      });
    } catch {
      const html = await readFile(join(ASSETS, "index.html"));
      return new Response(new Uint8Array(html), {
        headers: { "content-type": MIME[".html"] as string },
      });
    }
  };
}
