/**
 * Generic hibernatable presence + broadcast for a native (non-agent) DO grain
 * (#181).
 *
 * The load-bearing properties, all exercised with FAKE sockets (no live Workers
 * runtime needed for the broadcast/registration seam):
 *   - `broadcastFrame` serializes once and sends the frame to every OPEN socket,
 *     skipping a closed (`readyState`) one without calling `send`, skipping one
 *     that throws on `send`, and skipping the `except` socket — returning an
 *     honest `{ sent, skipped }` count.
 *   - `registerHibernatableSocket` calls `ctx.acceptWebSocket` with the tags and
 *     serializes the attachment iff one is given.
 *   - `presenceCount` reads `ctx.getWebSockets(tag).length`.
 *   - `acceptPresenceSocket` is exercised by type only (its `WebSocketPair`
 *     construction is runtime-only) — asserted to be a function.
 *
 * Globals are NOT enabled in vitest.config.ts — describe/it/expect are imported
 * explicitly, matching the rest of the package's test files. fast-check's seed +
 * numRuns are pinned globally by `src/test-setup.ts`.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AttachableSocket,
  acceptPresenceSocket,
  broadcastFrame,
  type PresenceCtx,
  type PresenceSocket,
  presenceCount,
  registerHibernatableSocket,
  WS_READY_STATE_OPEN,
} from "./presence";

// ── A recording fake socket: captures every frame `send` received, and can be
//    pinned OPEN/CLOSED or made to throw (a socket dying mid-broadcast). ───────
interface FakeSocket extends PresenceSocket {
  readonly received: string[];
}

function openSocket(): FakeSocket {
  const received: string[] = [];
  return {
    received,
    readyState: WS_READY_STATE_OPEN,
    send: (m) => {
      received.push(m);
    },
  };
}

function closedSocket(): FakeSocket {
  const received: string[] = [];
  return {
    received,
    readyState: WS_READY_STATE_OPEN + 2, // CLOSED — anything != OPEN
    send: (m) => {
      received.push(m);
    },
  };
}

/** A socket that throws on `send` (closing mid-broadcast); no `readyState`, so
 *  liveness is discovered only by the caught throw. */
function deadSocket(): FakeSocket {
  return {
    received: [],
    send: () => {
      throw new Error("dead socket");
    },
  };
}

describe("broadcastFrame — fan-out over a socket set (the input, DI-friendly)", () => {
  it("serializes once and sends the frame to every open socket", () => {
    const a = openSocket();
    const b = openSocket();
    const c = openSocket();
    const report = broadcastFrame([a, b, c], { kind: "tick", n: 7 });

    expect(report).toEqual({ sent: 3, skipped: 0 });
    for (const ws of [a, b, c]) {
      expect(ws.received).toEqual(['{"kind":"tick","n":7}']);
      expect(JSON.parse(ws.received[0])).toEqual({ kind: "tick", n: 7 });
    }
  });

  it("skips a closed socket (readyState != OPEN) WITHOUT calling send", () => {
    const live = openSocket();
    const closed = closedSocket();
    const report = broadcastFrame([live, closed], { kind: "x" });

    expect(report).toEqual({ sent: 1, skipped: 1 });
    expect(live.received).toEqual(['{"kind":"x"}']);
    expect(closed.received).toEqual([]); // send never attempted on a closed socket
  });

  it("skips a socket that throws on send; others still receive", () => {
    const dead = deadSocket();
    const live = openSocket();
    const report = broadcastFrame([dead, live], { kind: "x" });

    expect(report).toEqual({ sent: 1, skipped: 1 });
    expect(live.received).toEqual(['{"kind":"x"}']);
  });

  it("excludes the `except` socket (no echo to the sender)", () => {
    const sender = openSocket();
    const other = openSocket();
    const report = broadcastFrame(
      [sender, other],
      { kind: "msg" },
      {
        except: sender,
      },
    );

    expect(report).toEqual({ sent: 1, skipped: 1 });
    expect(sender.received).toEqual([]); // not echoed back
    expect(other.received).toEqual(['{"kind":"msg"}']);
  });

  it("uses a custom serialize when provided", () => {
    const a = openSocket();
    const report = broadcastFrame(
      [a],
      { kind: "raw" },
      {
        serialize: () => "PREENCODED",
      },
    );

    expect(report).toEqual({ sent: 1, skipped: 0 });
    expect(a.received).toEqual(["PREENCODED"]);
  });

  it("an empty socket set is a no-op {sent:0, skipped:0}", () => {
    expect(broadcastFrame([], { kind: "x" })).toEqual({ sent: 0, skipped: 0 });
  });

  it("property: every open socket receives exactly the frame; sent+skipped == total; dead get nothing", () => {
    fc.assert(
      fc.property(
        // A roster of sockets, each either open or dead-on-send.
        fc.array(fc.boolean(), { maxLength: 30 }),
        fc.jsonValue(),
        (liveness, frame) => {
          const sockets = liveness.map((isLive) =>
            isLive ? openSocket() : deadSocket(),
          );
          const expectedSent = liveness.filter(Boolean).length;

          const report = broadcastFrame(sockets, frame);
          const wire = JSON.stringify(frame);

          // Counts are honest and partition the whole roster.
          expect(report.sent).toBe(expectedSent);
          expect(report.skipped).toBe(sockets.length - expectedSent);
          expect(report.sent + report.skipped).toBe(sockets.length);

          // Every open socket got exactly the one serialized frame; dead none.
          sockets.forEach((ws, i) => {
            expect(ws.received).toEqual(liveness[i] ? [wire] : []);
          });
        },
      ),
    );
  });
});

// ── A fake DurableObjectState Hibernation slice: records accepts + tags, hands
//    sockets back from getWebSockets (optionally tag-filtered). ────────────────
interface AcceptCall {
  readonly ws: unknown;
  readonly tags: string[] | undefined;
}

function fakeCtx(registry: WebSocket[] = []): PresenceCtx & {
  readonly accepts: AcceptCall[];
} {
  const accepts: AcceptCall[] = [];
  return {
    accepts,
    acceptWebSocket: (ws, tags) => {
      accepts.push({ ws, tags });
      registry.push(ws);
    },
    getWebSockets: () => registry,
  };
}

describe("registerHibernatableSocket — Hibernation API accept + attachment", () => {
  it("accepts the server socket on the ctx (no tags when none given)", () => {
    const ctx = fakeCtx();
    const attachments: unknown[] = [];
    const server: AttachableSocket = {
      serializeAttachment: (v) => attachments.push(v),
    };

    registerHibernatableSocket(ctx, server);

    expect(ctx.accepts).toHaveLength(1);
    expect(ctx.accepts[0].ws).toBe(server);
    expect(ctx.accepts[0].tags).toBeUndefined();
    expect(attachments).toEqual([]); // no attachment ⇒ serializeAttachment not called
  });

  it("passes tags through and serializes the attachment when given", () => {
    const ctx = fakeCtx();
    const attachments: unknown[] = [];
    const server: AttachableSocket = {
      serializeAttachment: (v) => attachments.push(v),
    };

    registerHibernatableSocket(ctx, server, {
      tags: ["team:red"],
      attachment: { playerId: "p1" },
    });

    expect(ctx.accepts[0].tags).toEqual(["team:red"]);
    expect(attachments).toEqual([{ playerId: "p1" }]);
  });
});

describe("presenceCount — live connection count off getWebSockets", () => {
  it("returns the number of connected sockets", () => {
    const ctx = fakeCtx([{} as WebSocket, {} as WebSocket, {} as WebSocket]);
    expect(presenceCount(ctx)).toBe(3);
  });

  it("passes the tag through to getWebSockets", () => {
    let seenTag: string | undefined = "UNSET";
    const ctx: PresenceCtx = {
      acceptWebSocket: () => {},
      getWebSockets: (tag) => {
        seenTag = tag;
        return [];
      },
    };
    presenceCount(ctx, "team:red");
    expect(seenTag).toBe("team:red");
  });
});

describe("acceptPresenceSocket — typed-only (WebSocketPair is runtime-only)", () => {
  it("is exported as a function (its pair construction needs workerd)", () => {
    expect(typeof acceptPresenceSocket).toBe("function");
  });
});
