---
"@demlik/tea": minor
---

**`serveLaneViewer` — start the lane dashboard, rather than assemble it.** `laneViewer` returns a `(Request) => Response` for a host that already has a server. But everything *between* that handler and a running page — creating the server, turning node's request into a `Request`, reading a POST body, streaming the response back so the event stream stays open — is identical in every host, and asking each one to write it is asking each one to get it subtly wrong. The streaming especially: buffer the response and `/api/stream` never delivers a frame, which presents as "the page does not update" and is nobody's obvious bug.

So the three callbacks are now the whole integration. `serveLaneViewer(opts)` listens and hands back `{ url, close }`; `port: 0` takes a free one and reports it. It binds `127.0.0.1` by default, because this reads a machine's own disk and should stay on it. `laneViewer` is unchanged for anyone mounting it themselves.
