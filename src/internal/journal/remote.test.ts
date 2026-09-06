import { describe, expect, it } from "vitest";
import {
  type AuthoredRecord,
  makeSyncClient,
  memoryCursorStore,
  memoryRemoteJournal,
  type RemoteEntry,
  type RemoteJournal,
} from "./remote";

type Rec = { readonly tag: string };

/** A fold: reduce a converged log to an ordered `${author}:${tag}` list. The
 *  convergence claim is that two clients fold their logs to the same result. */
const fold = (log: ReadonlyArray<RemoteEntry<Rec>>): string[] =>
  log.map((entry) => `${entry.author}:${entry.record.tag}`);

const authored = (author: string, tag: string): AuthoredRecord<Rec> => ({
  author,
  record: { tag },
});

describe("memoryRemoteJournal", () => {
  it("push assigns a per-stream monotonic seq starting at 1", async () => {
    const remote = memoryRemoteJournal<Rec>();
    const first = await remote.push({
      token: null,
      stream: "s",
      records: [authored("a", "x"), authored("a", "y")],
    });
    expect(first.seqs).toEqual([1, 2]);
    const second = await remote.push({
      token: null,
      stream: "s",
      records: [authored("b", "z")],
    });
    expect(second.seqs).toEqual([3]);
  });

  it("seq is independent per stream", async () => {
    const remote = memoryRemoteJournal<Rec>();
    const s = await remote.push({
      token: null,
      stream: "s",
      records: [authored("a", "x")],
    });
    const t = await remote.push({
      token: null,
      stream: "t",
      records: [authored("a", "y")],
    });
    expect(s.seqs).toEqual([1]);
    expect(t.seqs).toEqual([1]);
  });

  it("pull returns only entries after `since`, in seq order, with author kept", async () => {
    const remote = memoryRemoteJournal<Rec>();
    await remote.push({
      token: null,
      stream: "s",
      records: [authored("a", "x"), authored("b", "y")],
    });
    const all = await remote.pull({ token: null, stream: "s", since: 0 });
    expect(all.entries).toEqual([
      { stream: "s", seq: 1, author: "a", record: { tag: "x" } },
      { stream: "s", seq: 2, author: "b", record: { tag: "y" } },
    ]);
    const tail = await remote.pull({ token: null, stream: "s", since: 1 });
    expect(tail.entries).toEqual([
      { stream: "s", seq: 2, author: "b", record: { tag: "y" } },
    ]);
  });

  it("pull is empty for an unwritten stream", async () => {
    const remote = memoryRemoteJournal<Rec>();
    const { entries } = await remote.pull({
      token: null,
      stream: "never",
      since: 0,
    });
    expect(entries).toEqual([]);
  });

  it("concurrent pushes serialise into one total order (no lost seq)", async () => {
    const remote = memoryRemoteJournal<Rec>();
    await Promise.all([
      remote.push({
        token: null,
        stream: "s",
        records: [authored("a", "a1"), authored("a", "a2")],
      }),
      remote.push({
        token: null,
        stream: "s",
        records: [authored("b", "b1"), authored("b", "b2")],
      }),
    ]);
    const { entries } = await remote.pull({
      token: null,
      stream: "s",
      since: 0,
    });
    // Four distinct records, gap-free seqs 1..4, and each author's batch is a
    // contiguous run (the batch held the lock as a whole).
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const tags = entries.map((e) => `${e.author}:${e.record.tag}`);
    expect(new Set(tags)).toEqual(new Set(["a:a1", "a:a2", "b:b1", "b:b2"]));
    const aRun = tags.filter((t) => t.startsWith("a:"));
    const bRun = tags.filter((t) => t.startsWith("b:"));
    expect(aRun).toEqual(["a:a1", "a:a2"]);
    expect(bRun).toEqual(["b:b1", "b:b2"]);
  });

  it("ignores the opaque token (auth is the host's concern, out of scope)", async () => {
    const remote = memoryRemoteJournal<Rec>();
    // Two different tokens write to and read from the same stream freely — the
    // primitive enforces nothing about who may push where.
    await remote.push({
      token: { who: "one" },
      stream: "s",
      records: [authored("a", "x")],
    });
    const { entries } = await remote.pull({
      token: "a-totally-different-token",
      stream: "s",
      since: 0,
    });
    expect(entries.map((e) => e.record.tag)).toEqual(["x"]);
  });
});

describe("makeSyncClient", () => {
  it("a local append is provisional until sync gives it a remote seq", async () => {
    const remote = memoryRemoteJournal<Rec>();
    const client = makeSyncClient({ remote, author: "a" });

    await client.append("s", { tag: "x" });
    // Provisional: appended locally, but not yet in the converged (remote) log.
    expect(client.log("s")).toEqual([]);
    expect(await client.pending("s")).toEqual([authored("a", "x")]);

    await client.sync("s");
    // Acked: now it carries a remote seq and sits in the converged log, and the
    // pending tail is drained.
    expect(client.log("s")).toEqual([
      { stream: "s", seq: 1, author: "a", record: { tag: "x" } },
    ]);
    expect(await client.pending("s")).toEqual([]);
  });

  it("sync resumes incrementally — a second sync re-pushes and re-pulls nothing", async () => {
    const remote = memoryRemoteJournal<Rec>();
    const pulls: number[] = [];
    // Wrap the remote to count how much each pull actually returns.
    const counting: RemoteJournal<Rec> = {
      push: (req) => remote.push(req),
      pull: async (req) => {
        const res = await remote.pull(req);
        pulls.push(res.entries.length);
        return res;
      },
    };
    const client = makeSyncClient({ remote: counting, author: "a" });

    await client.append("s", { tag: "x" });
    await client.sync("s");
    await client.sync("s"); // nothing new locally, nothing new remotely

    expect(pulls).toEqual([1, 0]); // first sync pulled 1, second pulled 0
    expect(client.log("s")).toHaveLength(1); // not duplicated
    expect(await client.pending("s")).toEqual([]); // not re-pushed
  });

  it("carries a durable cursor store so sync survives a restart", async () => {
    const remote = memoryRemoteJournal<Rec>();
    const cursors = memoryCursorStore();

    const first = makeSyncClient({ remote, author: "a", cursors });
    await first.append("s", { tag: "x" });
    await first.sync("s");
    expect(await cursors.get("s")).toBe(1);

    // A fresh client sharing the cursor store pulls only what is new (nothing),
    // proving the cursor — not client memory — drives resumption.
    const restarted = makeSyncClient({ remote, author: "a", cursors });
    await restarted.sync("s");
    expect(restarted.log("s")).toEqual([]); // cursor was already at 1
  });

  it("stamps this client's author on every record it pushes", async () => {
    const remote = memoryRemoteJournal<Rec>();
    const client = makeSyncClient({ remote, author: "device-42" });
    await client.append("s", { tag: "x" });
    await client.sync("s");
    const { entries } = await remote.pull({
      token: null,
      stream: "s",
      since: 0,
    });
    expect(entries.map((e) => e.author)).toEqual(["device-42"]);
  });

  it("two clients that each append offline converge on one order after sync — the network-in-the-middle twin of phoenix spike #6673", async () => {
    const remote = memoryRemoteJournal<Rec>();
    const alice = makeSyncClient({ remote, author: "alice" });
    const bob = makeSyncClient({ remote, author: "bob" });

    // Both append OFFLINE — no sync yet, so neither sees the other and neither
    // has a remote seq. This is the disconnected-both-writing situation.
    await alice.append("issue", { tag: "alice-claim" });
    await alice.append("issue", { tag: "alice-comment" });
    await bob.append("issue", { tag: "bob-claim" });
    await bob.append("issue", { tag: "bob-comment" });

    expect(alice.log("issue")).toEqual([]);
    expect(bob.log("issue")).toEqual([]);

    // They race to sync. Each pushes its offline appends and pulls what it can
    // see so far; a single round may miss a peer's concurrently-pushed records.
    await Promise.all([alice.sync("issue"), bob.sync("issue")]);
    // A second round — with nothing new to push — pulls the tail each missed.
    await Promise.all([alice.sync("issue"), bob.sync("issue")]);

    const aliceFold = fold(alice.log("issue"));
    const bobFold = fold(bob.log("issue"));

    // The convergence claim: both local folds agree on ONE order.
    expect(aliceFold).toEqual(bobFold);
    // That one order is a total order over every record both wrote — nothing
    // merged, nothing lost; the fold over the remote's order IS the merge.
    expect(new Set(aliceFold)).toEqual(
      new Set([
        "alice:alice-claim",
        "alice:alice-comment",
        "bob:bob-claim",
        "bob:bob-comment",
      ]),
    );
    // And the remote seqs are gap-free 1..4 — the honest total order key.
    expect(alice.log("issue").map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
});
