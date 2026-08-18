---
"@demlik/tea": minor
---

**`chart/lane/server` — the lane dashboard as something a host can serve.** `chart/lane/react` gives you the components and assumes you have a bundler. A CLI does not, and the consumer this was written for is one: it already knows where its lanes are, how to fold one and how to record an event, and what it lacks is a page. So this ships the page **prebuilt** and asks the host for the three facts only the host can know — where the lanes are, how an event is recorded, and (optionally) who holds a lane. `laneViewer(opts)` returns a `(Request) => Promise<Response>`, so it mounts under Node's `http`, Bun.serve, Hono or a Worker with no per-framework adapter.

The contract the page speaks is four endpoints: `GET /api/lanes`, `GET /api/stream` (SSE, liveness is the library's problem — it re-asks `lanes()` and pushes on change, so no host writes a watcher), `GET /api/drivers` and `POST /api/transition`.

**The host stays the only writer.** `transition` is the host's own verb; the page proposes and the host disposes, and a refusal is an answer displayed in the host's own words rather than an error the page invents. Omit `transition` entirely and the dashboard is read-only, which is a real mode and not a degraded one. `drivers` is optional because ownership is not in the lane files at all — absent means UNKNOWN and renders nothing, never "free", because a lane shown free while someone holds it is what starts a second driver on one piece of work.

`examples/lane-dashboard/serve.ts` is a complete host in ~120 lines, most of it reading two files.
