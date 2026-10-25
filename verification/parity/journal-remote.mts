import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  type Journal,
  memoryJournal,
} from "../../packages/tea/src/internal/journal/index.js";
import {
  type AuthoredRecord,
  type CursorStore,
  type LocalJournal,
  makeSyncClient,
  memoryCursorStore,
  memoryRemoteJournal,
  type RemoteEntry,
  type RemoteJournal,
  type SyncClient,
} from "../../packages/tea/src/internal/journal/remote.js";
import { decode, normalize } from "./timing-clock.mts";

const data = z.unknown().refine((value) => z.json().safeParse(value).success);
const text = z.union([
  z.string(),
  z.object({ $utf16: z.array(z.number().int().min(0).max(65535)) }).strict(),
]);
const number = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const point = z.enum([
  "localAppend",
  "localList",
  "push",
  "pull",
  "cursorGet",
  "cursorSet",
]);
const stage = z.enum(["before", "after"]);
const entry = z
  .object({ stream: text, seq: number, author: text, record: z.string() })
  .strict();
const clientStream = { client: z.string(), stream: text };
const action = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("append"), ...clientStream, record: z.string() })
    .strict(),
  z
    .object({
      op: z.enum(["pending", "sync", "log", "cursorGet", "localList"]),
      ...clientStream,
    })
    .strict(),
  z
    .object({ op: z.literal("cursorSet"), ...clientStream, seq: number })
    .strict(),
  z
    .object({
      op: z.literal("restart"),
      client: z.string(),
      keep_local: z.boolean(),
      keep_cursors: z.boolean(),
    })
    .strict(),
  z
    .object({
      op: z.literal("fault"),
      client: z.string(),
      at: point,
      stage,
      error: data,
    })
    .strict(),
  z
    .object({ op: z.literal("mutate"), record: z.string(), value: data })
    .strict(),
  z
    .object({
      op: z.enum(["snapshot", "checkSnapshot", "clearSnapshot"]),
      ...clientStream,
      name: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.literal("batchPush"),
      batches: z.array(
        z
          .object({ stream: text, author: text, records: z.array(z.string()) })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({ op: z.enum(["pull", "pullTwice"]), stream: text, since: number })
    .strict(),
  z
    .object({
      op: z.literal("pushReply"),
      client: z.string(),
      seqs: z.array(number),
    })
    .strict(),
  z
    .object({
      op: z.literal("pullReply"),
      client: z.string(),
      entries: z.array(entry),
    })
    .strict(),
  z
    .object({
      op: z.literal("heldSync"),
      first: z.string(),
      second: z.string(),
      stream: text,
      at: point.exclude(["localAppend"]),
      stage,
    })
    .strict(),
  z.object({ op: z.literal("overlap"), ...clientStream }).strict(),
  z
    .object({
      op: z.literal("heldPair"),
      first: z.string(),
      second: z.string(),
      stream: text,
      at: point.exclude(["localAppend"]),
      stage,
      reverse: z.boolean(),
    })
    .strict(),
]);
export const journalRemoteScript = z
  .object({
    records: z.array(z.object({ id: z.string(), value: data }).strict()),
    clients: z.array(
      z.object({ id: z.string(), author: text, token: data }).strict(),
    ),
    actions: z.array(action),
  })
  .strict();
type Script = z.infer<typeof journalRemoteScript>;
type Point = z.infer<typeof point>;
type Stage = z.infer<typeof stage>;
type Cell = { value: unknown };
type Host = {
  id: string;
  author: string;
  token: unknown;
  local: Journal<Cell>;
  cursors: CursorStore;
  client: SyncClient<Cell>;
};
function txt(value: z.infer<typeof text>): string {
  return typeof value === "string"
    ? value
    : String.fromCharCode(...value.$utf16);
}
function num(value: z.infer<typeof number>): number {
  if (typeof value === "number") return value;
  switch (value.$number) {
    case "NaN":
      return Number.NaN;
    case "Infinity":
      return Number.POSITIVE_INFINITY;
    case "-Infinity":
      return Number.NEGATIVE_INFINITY;
    case "-0":
      return -0;
  }
}
class Gate {
  arrived = 0;
  changed: Array<() => void> = [];
  readonly released: Promise<void>;
  release: () => void = () => {};
  constructor() {
    this.released = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  async arrive() {
    this.arrived += 1;
    for (const change of this.changed.splice(0)) change();
    await this.released;
  }
  async wait(count: number) {
    while (this.arrived < count)
      await new Promise<void>((resolve) => this.changed.push(resolve));
  }
}
type Behavior = { kind: "fail"; value: unknown } | { kind: "hold"; gate: Gate };
type Rule = { stage: Stage; remaining: number; behavior: Behavior };
export async function executeJournalRemote(input: unknown) {
  const script = journalRemoteScript.parse(input);
  const records = new Map(
    script.records.map((record) => [
      record.id,
      { value: decode(record.value) },
    ]),
  );
  const events: unknown[] = [],
    sourceCalls: string[] = [],
    rows: unknown[] = [];
  const observe = <T,>(name: string, call: () => T): T => {
    const result = call();
    sourceCalls.push(name);
    return result;
  };
  const remote = observe("memoryRemoteJournal", () =>
    memoryRemoteJournal<Cell>(),
  );
  const rules = new Map<string, Rule>();
  const pushReplies = new Map<string, number[]>(),
    pullReplies = new Map<string, RemoteEntry<Cell>[]>();
  const hosts = new Map<string, Host>(),
    snapshots = new Map<string, ReadonlyArray<RemoteEntry<Cell>>>();
  let lastFailure: { phase: string; value: unknown } | undefined;
  const record = (value: Cell) => ({
    id: [...records].find(([, cell]) => cell === value)?.[0] ?? null,
    value: normalize(value.value),
  });
  const authored = (values: ReadonlyArray<AuthoredRecord<Cell>>) =>
    values.map((value) => ({
      author: normalize(value.author),
      record: record(value.record),
    }));
  const entries = (values: ReadonlyArray<RemoteEntry<Cell>>) =>
    values.map((value) => ({
      stream: normalize(value.stream),
      seq: normalize(value.seq),
      author: normalize(value.author),
      record: record(value.record),
    }));
  const begin = (
    host: Omit<Host, "client">,
    at: Point,
    stream: string,
    extra: unknown,
  ): Rule | undefined => {
    events.push({
      client: host.id,
      op: at,
      stream: normalize(stream),
      data: extra,
    });
    const key = `${host.id}:${at}`,
      rule = rules.get(key);
    if (rule) {
      rule.remaining -= 1;
      if (!rule.remaining) rules.delete(key);
    }
    return rule;
  };
  const boundary = async (
    host: Omit<Host, "client">,
    at: Point,
    rule: Rule,
  ) => {
    const common = { client: host.id, at, stage: rule.stage };
    switch (rule.behavior.kind) {
      case "fail": {
        events.push({
          ...common,
          op: "fail",
          value: normalize(rule.behavior.value),
        });
        lastFailure = {
          phase: at === "localAppend" || at === "localList" ? "local" : at,
          value: rule.behavior.value,
        };
        throw rule.behavior.value;
      }
      case "hold":
        events.push({ ...common, op: "held" });
        await rule.behavior.gate.arrive();
        events.push({ ...common, op: "released" });
        return;
    }
  };
  const build = (host: Omit<Host, "client">): Host => {
    const current = host;
    const local: LocalJournal<Cell> = {
      async append(stream, value) {
        const rule = begin(current, "localAppend", stream, record(value));
        if (rule?.stage === "before")
          await boundary(current, "localAppend", rule);
        const result = await observe("Journal.append", () =>
          current.local.append(stream, value),
        );
        if (rule?.stage === "after")
          await boundary(current, "localAppend", rule);
        return result;
      },
      async list(stream) {
        const rule = begin(current, "localList", stream, null);
        if (rule?.stage === "before")
          await boundary(current, "localList", rule);
        const result = await observe("Journal.list", () =>
          current.local.list(stream),
        );
        if (rule?.stage === "after") await boundary(current, "localList", rule);
        return result;
      },
    };
    const cursors: CursorStore = {
      async get(stream) {
        const rule = begin(current, "cursorGet", stream, null);
        if (rule?.stage === "before")
          await boundary(current, "cursorGet", rule);
        const result = await observe("CursorStore.get", () =>
          current.cursors.get(stream),
        );
        if (rule?.stage === "after") await boundary(current, "cursorGet", rule);
        return result;
      },
      async set(stream, seq) {
        const rule = begin(current, "cursorSet", stream, normalize(seq));
        if (rule?.stage === "before")
          await boundary(current, "cursorSet", rule);
        await observe("CursorStore.set", () =>
          current.cursors.set(stream, seq),
        );
        if (rule?.stage === "after") await boundary(current, "cursorSet", rule);
      },
    };
    const transport: RemoteJournal<Cell> = {
      async push(request) {
        const rule = begin(current, "push", request.stream, {
          tokenSame: Object.is(request.token, current.token),
          records: authored(request.records),
        });
        if (rule?.stage === "before") await boundary(current, "push", rule);
        let result = await observe("RemoteJournal.push", () =>
          remote.push(request),
        );
        const seqs = pushReplies.get(current.id);
        if (seqs !== undefined) {
          pushReplies.delete(current.id);
          result = { seqs };
        }
        if (rule?.stage === "after") await boundary(current, "push", rule);
        return result;
      },
      async pull(request) {
        const rule = begin(current, "pull", request.stream, {
          tokenSame: Object.is(request.token, current.token),
          since: normalize(request.since),
        });
        if (rule?.stage === "before") await boundary(current, "pull", rule);
        let result = await observe("RemoteJournal.pull", () =>
          remote.pull(request),
        );
        const values = pullReplies.get(current.id);
        if (values !== undefined) {
          pullReplies.delete(current.id);
          result = { entries: values };
        }
        if (rule?.stage === "after") await boundary(current, "pull", rule);
        return result;
      },
    };
    const client = observe("makeSyncClient", () =>
      makeSyncClient({
        remote: transport,
        author: current.author,
        token: current.token,
        local,
        cursors,
      }),
    );
    return { ...current, client };
  };
  for (const client of script.clients)
    hosts.set(
      client.id,
      build({
        id: client.id,
        author: txt(client.author),
        token: decode(client.token),
        local: observe("memoryJournal", () => memoryJournal()),
        cursors: observe("memoryCursorStore", memoryCursorStore),
      }),
    );
  const ok = (value: unknown) => ({ ok: true, value });
  const settle = async (value: Promise<unknown>) => {
    try {
      return ok((await value) ?? null);
    } catch (error) {
      assert(lastFailure && Object.is(lastFailure.value, error));
      return { ok: false, phase: lastFailure.phase, error: normalize(error) };
    }
  };
  const use = (id: string): Host => {
    const host = hosts.get(id);
    assert(host, `unknown client ${id}`);
    return host;
  };
  const payload = (id: string): Cell => {
    const value = records.get(id);
    assert(value, `unknown record ${id}`);
    return value;
  };
  for (const item of script.actions) {
    let result: unknown;
    switch (item.op) {
      case "append":
        result = await settle(
          observe("SyncClient.append", () =>
            use(item.client).client.append(
              txt(item.stream),
              payload(item.record),
            ),
          ),
        );
        break;
      case "sync":
        result = await settle(
          observe("SyncClient.sync", () =>
            use(item.client).client.sync(txt(item.stream)),
          ),
        );
        break;
      case "pending":
        result = await settle(
          observe("SyncClient.pending", () =>
            use(item.client).client.pending(txt(item.stream)),
          ).then(authored),
        );
        break;
      case "log":
        result = ok(
          entries(
            observe("SyncClient.log", () =>
              use(item.client).client.log(txt(item.stream)),
            ),
          ),
        );
        break;
      case "cursorGet":
        result = ok(
          normalize(
            await observe("CursorStore.get", () =>
              use(item.client).cursors.get(txt(item.stream)),
            ),
          ),
        );
        break;
      case "cursorSet":
        await observe("CursorStore.set", () =>
          use(item.client).cursors.set(txt(item.stream), num(item.seq)),
        );
        result = ok(null);
        break;
      case "localList":
        result = ok(
          (
            await observe("Journal.list", () =>
              use(item.client).local.list(txt(item.stream)),
            )
          ).map((value) => ({
            stream: normalize(value.stream),
            seq: normalize(value.seq),
            record: record(value.record),
          })),
        );
        break;
      case "restart": {
        const previous = use(item.client);
        hosts.set(
          item.client,
          build({
            ...previous,
            local: item.keep_local
              ? previous.local
              : observe("memoryJournal", () => memoryJournal()),
            cursors: item.keep_cursors
              ? previous.cursors
              : observe("memoryCursorStore", memoryCursorStore),
          }),
        );
        result = ok(null);
        break;
      }
      case "fault":
        rules.set(`${item.client}:${item.at}`, {
          stage: item.stage,
          remaining: 1,
          behavior: { kind: "fail", value: decode(item.error) },
        });
        result = ok(null);
        break;
      case "mutate":
        payload(item.record).value = decode(item.value);
        result = ok(null);
        break;
      case "snapshot": {
        const values = observe("SyncClient.log", () =>
          use(item.client).client.log(txt(item.stream)),
        );
        snapshots.set(item.name, values);
        result = ok(entries(values));
        break;
      }
      case "checkSnapshot": {
        const values = observe("SyncClient.log", () =>
            use(item.client).client.log(txt(item.stream)),
          ),
          snapshot = snapshots.get(item.name);
        assert(snapshot);
        result = ok({
          snapshot: entries(snapshot),
          current: entries(values),
          sameEntries: snapshot.map((value, index) => value === values[index]),
        });
        break;
      }
      case "clearSnapshot": {
        const snapshot = snapshots.get(item.name);
        assert(snapshot);
        // The source contract is a readonly view over a fresh ordinary array.
        Reflect.set(snapshot, "length", 0);
        result = ok({
          length: observe("SyncClient.log", () =>
            use(item.client).client.log(txt(item.stream)),
          ).length,
        });
        break;
      }
      case "batchPush": {
        const values = item.batches.map((batch) =>
          observe("RemoteJournal.push", () =>
            remote.push({
              token: undefined,
              stream: txt(batch.stream),
              records: batch.records.map((id) => ({
                author: txt(batch.author),
                record: payload(id),
              })),
            }),
          ),
        );
        result = ok(
          (await Promise.all(values)).map((value) => value.seqs.map(normalize)),
        );
        break;
      }
      case "pull":
        result = ok(
          entries(
            (
              await observe("RemoteJournal.pull", () =>
                remote.pull({
                  token: undefined,
                  stream: txt(item.stream),
                  since: num(item.since),
                }),
              )
            ).entries,
          ),
        );
        break;
      case "pullTwice": {
        const first = (
          await observe("RemoteJournal.pull", () =>
            remote.pull({
              token: undefined,
              stream: txt(item.stream),
              since: num(item.since),
            }),
          )
        ).entries;
        const second = (
          await observe("RemoteJournal.pull", () =>
            remote.pull({
              token: undefined,
              stream: txt(item.stream),
              since: num(item.since),
            }),
          )
        ).entries;
        result = ok({
          first: entries(first),
          second: entries(second),
          sameEntries: first.map((value, index) => value === second[index]),
          sameRecords: first.map(
            (value, index) => value.record === second[index]?.record,
          ),
        });
        break;
      }
      case "pushReply":
        pushReplies.set(item.client, item.seqs.map(num));
        result = ok(null);
        break;
      case "pullReply":
        pullReplies.set(
          item.client,
          item.entries.map((value) => ({
            stream: txt(value.stream),
            seq: num(value.seq),
            author: txt(value.author),
            record: payload(value.record),
          })),
        );
        result = ok(null);
        break;
      case "heldSync": {
        const first = use(item.first),
          second = use(item.second),
          stream = txt(item.stream),
          gate = new Gate();
        rules.set(`${first.id}:${item.at}`, {
          stage: item.stage,
          remaining: 1,
          behavior: { kind: "hold", gate },
        });
        const receipt = observe("SyncClient.sync", () =>
          first.client.sync(stream),
        );
        await gate.wait(1);
        const held = {
          first: entries(
            observe("SyncClient.log", () => first.client.log(stream)),
          ),
          second: entries(
            observe("SyncClient.log", () => second.client.log(stream)),
          ),
        };
        const secondResult = await settle(
          observe("SyncClient.sync", () => second.client.sync(stream)),
        );
        const whileHeld = {
          first: entries(
            observe("SyncClient.log", () => first.client.log(stream)),
          ),
          second: entries(
            observe("SyncClient.log", () => second.client.log(stream)),
          ),
        };
        gate.release();
        result = ok({
          held,
          whileHeld,
          first: await settle(receipt),
          second: secondResult,
        });
        break;
      }
      case "heldPair": {
        const first = use(item.first),
          second = use(item.second),
          stream = txt(item.stream),
          a = new Gate(),
          b = new Gate();
        rules.set(`${first.id}:${item.at}`, {
          stage: item.stage,
          remaining: 1,
          behavior: { kind: "hold", gate: a },
        });
        rules.set(`${second.id}:${item.at}`, {
          stage: item.stage,
          remaining: 1,
          behavior: { kind: "hold", gate: b },
        });
        const firstReceipt = observe("SyncClient.sync", () =>
          first.client.sync(stream),
        );
        await a.wait(1);
        const secondReceipt = observe("SyncClient.sync", () =>
          second.client.sync(stream),
        );
        await b.wait(1);
        const state = () => ({
          first: entries(
            observe("SyncClient.log", () => first.client.log(stream)),
          ),
          second: entries(
            observe("SyncClient.log", () => second.client.log(stream)),
          ),
        });
        const held = state();
        let firstResult: unknown, secondResult: unknown, afterOne: unknown;
        if (item.reverse) {
          b.release();
          secondResult = await settle(secondReceipt);
          afterOne = state();
          a.release();
          firstResult = await settle(firstReceipt);
        } else {
          a.release();
          firstResult = await settle(firstReceipt);
          afterOne = state();
          b.release();
          secondResult = await settle(secondReceipt);
        }
        result = ok({
          held,
          afterOne,
          first: firstResult,
          second: secondResult,
        });
        break;
      }
      case "overlap": {
        const host = use(item.client),
          stream = txt(item.stream),
          gate = new Gate();
        rules.set(`${host.id}:cursorGet`, {
          stage: "after",
          remaining: 2,
          behavior: { kind: "hold", gate },
        });
        const first = observe("SyncClient.sync", () =>
            host.client.sync(stream),
          ),
          second = observe("SyncClient.sync", () => host.client.sync(stream));
        await gate.wait(2);
        const held = entries(
          observe("SyncClient.log", () => host.client.log(stream)),
        );
        gate.release();
        result = ok({
          held,
          results: await Promise.all([settle(first), settle(second)]),
        });
        break;
      }
    }
    rows.push({ result, events: events.splice(0) });
  }
  return { comparison: rows, observedSourceCalls: sourceCalls };
}

type Case = { id: string; script: Script };
export function journalRemoteCases(): Case[] {
  const cases: Case[] = [];
  const add = (
    id: string,
    actions: unknown[],
    overrides: Record<string, unknown> = {},
  ) =>
    cases.push({
      id: `journal.remote.${id}`,
      script: journalRemoteScript.parse({
        records: [
          { id: "r", value: { kind: "open", issue: "DEM-1" } },
          { id: "next", value: ["comment", 2] },
          { id: "last", value: { $undefined: true } },
        ],
        clients: [
          { id: "a", author: "alice", token: { session: 1 } },
          { id: "b", author: "bob", token: { session: 2 } },
        ],
        actions,
        ...overrides,
      }),
    });
  const at = (op: string, client = "a", stream: unknown = "s", extra = {}) => ({
    op,
    client,
    stream,
    ...extra,
  });
  const append = (client = "a", record = "r", stream: unknown = "s") =>
    at("append", client, stream, { record });
  const pull = (since: unknown = 0, stream: unknown = "s") => ({
    op: "pull",
    since,
    stream,
  });
  const logs = () => [
    at("log"),
    at("log", "b"),
    at("pending"),
    at("pending", "b"),
    at("cursorGet"),
    at("cursorGet", "b"),
    pull(),
  ];
  add("offline-two-clients", [
    append(),
    append("b", "next"),
    at("log"),
    at("pending"),
    at("sync"),
    at("sync", "b"),
    at("sync"),
    ...logs(),
  ]);
  add("incremental-tail-and-cursor", [
    at("sync"),
    append(),
    at("sync"),
    at("sync"),
    append("a", "next"),
    at("pending"),
    at("sync"),
    append("b", "last"),
    at("sync", "b"),
    at("sync"),
    ...logs(),
  ]);
  add("streams-and-utf16", [
    append("a", "r", "__proto__"),
    append("a", "next", { $utf16: [0xd800] }),
    append("b", "last", ""),
    at("sync", "a", "__proto__"),
    at("sync", "a", { $utf16: [0xd800] }),
    at("sync", "b", ""),
    at("sync", "b", "__proto__"),
    pull(0, "__proto__"),
    pull(0, { $utf16: [0xd800] }),
    pull(0, ""),
    pull(0, "missing"),
  ]);
  for (const keep_local of [false, true])
    for (const keep_cursors of [false, true])
      add(`restart-${keep_local}-${keep_cursors}`, [
        append(),
        at("sync"),
        { op: "restart", client: "a", keep_local, keep_cursors },
        at("log"),
        at("pending"),
        at("cursorGet"),
        at("sync"),
        ...logs(),
      ]);
  add("record-and-entry-identity", [
    append(),
    at("sync"),
    at("sync", "b"),
    at("snapshot", "a", "s", { name: "old" }),
    {
      op: "mutate",
      record: "r",
      value: { edited: true, value: { $number: "NaN" } },
    },
    at("checkSnapshot", "a", "s", { name: "old" }),
    at("log", "b"),
    { op: "pullTwice", stream: "s", since: 0 },
    at("clearSnapshot", "a", "s", { name: "old" }),
    at("log"),
    at("localList"),
  ]);
  add("whole-push-batches", [
    {
      op: "batchPush",
      batches: [
        { stream: "s", author: "one", records: ["r", "next", "r"] },
        { stream: "s", author: "two", records: ["last", "next"] },
        { stream: "other", author: "three", records: ["r", "last"] },
      ],
    },
    pull(),
    pull(0, "other"),
    {
      op: "batchPush",
      batches: [{ stream: "s", author: "empty", records: [] }],
    },
    pull(),
  ]);
  for (const since of [
    0,
    1,
    -1,
    { $number: "-0" },
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
  ])
    add(`strict-since-${JSON.stringify(since)}`, [
      append(),
      at("sync"),
      pull(since),
    ]);
  for (const seq of [
    0,
    -3.25,
    { $number: "-0" },
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
  ])
    add(`numeric-cursor-${JSON.stringify(seq)}`, [
      at("cursorGet"),
      at("cursorSet", "a", "s", { seq }),
      at("cursorGet"),
      append(),
      at("sync"),
      at("cursorGet"),
      at("log"),
    ]);
  add("ignores-push-ack-seqs", [
    append(),
    { op: "pushReply", client: "a", seqs: [{ $number: "NaN" }, -99] },
    at("sync"),
    ...logs(),
  ]);
  add("custom-pull-order-and-last-cursor", [
    {
      op: "pullReply",
      client: "a",
      entries: [
        { stream: "foreign", seq: 8, author: "service", record: "r" },
        { stream: "s", seq: -2, author: "other", record: "next" },
      ],
    },
    at("sync"),
    at("log"),
    at("cursorGet"),
    at("sync"),
    at("log"),
  ]);
  add("custom-pull-nonfinite-last", [
    {
      op: "pullReply",
      client: "a",
      entries: [
        {
          stream: "s",
          seq: { $number: "NaN" },
          author: "service",
          record: "r",
        },
      ],
    },
    at("sync"),
    at("cursorGet"),
    at("log"),
    at("sync"),
    at("log"),
  ]);
  const failures = [
    { _tag: "offline", code: 7 },
    { $undefined: true },
    { $number: "NaN" },
  ];
  for (const atPoint of point.options)
    for (const when of stage.options)
      for (const [index, error] of failures.entries())
        add(`failure-${atPoint}-${when}-${index}`, [
          append(),
          { op: "fault", client: "a", at: atPoint, stage: when, error },
          atPoint === "localAppend" ? append("a", "next") : at("sync"),
          at("pending"),
          at("log"),
          at("cursorGet"),
          at("localList"),
          pull(),
          at("sync"),
          at("pending"),
          at("sync", "b"),
          at("sync"),
          ...logs(),
        ]);
  for (const atPoint of point.exclude(["localAppend"]).options)
    for (const when of stage.options)
      add(`held-independent-${atPoint}-${when}`, [
        append(),
        append("b", "next"),
        {
          op: "heldSync",
          first: "a",
          second: "b",
          stream: "s",
          at: atPoint,
          stage: when,
        },
        at("sync"),
        at("sync", "b"),
        ...logs(),
      ]);
  for (const atPoint of ["push", "cursorSet"] as const)
    for (const when of stage.options)
      add(`held-same-client-${atPoint}-${when}`, [
        append(),
        {
          op: "heldSync",
          first: "a",
          second: "a",
          stream: "s",
          at: atPoint,
          stage: when,
        },
        append("a", "next"),
        at("pending"),
        at("sync"),
        ...logs(),
      ]);
  for (const atPoint of point.exclude(["localAppend"]).options)
    for (const when of stage.options)
      for (const reverse of [false, true])
        add(`held-pair-${atPoint}-${when}-${reverse}`, [
          append(),
          append("b", "next"),
          {
            op: "heldPair",
            first: "a",
            second: "b",
            stream: "s",
            at: atPoint,
            stage: when,
            reverse,
          },
          at("sync"),
          at("sync", "b"),
          ...logs(),
        ]);
  add("overlapping-cursor-reads", [
    append(),
    at("overlap"),
    at("log"),
    append("a", "next"),
    at("pending"),
    at("sync"),
    ...logs(),
  ]);
  let seed = 0x19a16c9d;
  const draw = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let sample = 0; sample < 12; sample += 1) {
    const actions: unknown[] = [];
    for (let step = 0; step < 18; step += 1) {
      const client = draw() & 1 ? "a" : "b",
        stream = draw() % 3 ? "s" : "second";
      switch (draw() % 5) {
        case 0:
        case 1:
          actions.push(
            append(client, ["r", "next", "last"][draw() % 3], stream),
          );
          break;
        case 2:
          actions.push(at("sync", client, stream));
          break;
        case 3:
          actions.push(at("pending", client, stream));
          break;
        case 4:
          actions.push(at("log", client, stream));
          break;
      }
    }
    for (const stream of ["s", "second"])
      actions.push(
        at("sync", "a", stream),
        at("sync", "b", stream),
        at("sync", "a", stream),
        at("log", "a", stream),
        at("log", "b", stream),
        pull(0, stream),
      );
    add(`sequence-${sample}`, actions);
  }
  return cases;
}

function command(
  executable: string,
  args: string[],
  input?: string,
  cwd = process.cwd(),
  env = process.env,
) {
  const result = spawnSync(executable, args, {
    input,
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 300000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${executable} failed: ${result.stderr.slice(-12000)}`,
  );
  return result.stdout;
}
function binary(cwd = process.cwd(), target = process.env.CARGO_TARGET_DIR) {
  return join(
    target ? resolve(cwd, target) : join(cwd, "target"),
    "debug/journal_remote_driver",
  );
}
function build(cwd = process.cwd(), target?: string) {
  command(
    process.env.CARGO ?? "cargo",
    [
      "build",
      "--locked",
      "-p",
      "demlik-parity",
      "--bin",
      "journal_remote_driver",
    ],
    undefined,
    cwd,
    {
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      CARGO_INCREMENTAL: "0",
      CARGO_BUILD_JOBS: "1",
      ...(target ? { CARGO_TARGET_DIR: target } : {}),
    },
  );
}
const response = z
  .object({
    comparison: z.array(z.unknown()),
    observedRustCalls: z.array(z.string()).nonempty(),
  })
  .strict();
function native(cases: Case[], executable: string) {
  return command(
    executable,
    [],
    `${cases.map((item) => JSON.stringify(item.script)).join("\n")}\n`,
  )
    .trim()
    .split("\n")
    .map((line) => response.parse(JSON.parse(line)));
}
const digest = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const pushAwait = `state
                    .options
                    .remote
                    .push(PushRequest {
                        token: state.options.token.clone(),
                        stream: stream.clone(),
                        records,
                    })
                    .await
                    .map_err(|error| JournalError::Backend(SyncFailure::Push(error)))?;`;
const cursorCommit = `state
                    .options
                    .cursors
                    .set(stream, seq)
                    .await
                    .map_err(|error| JournalError::Backend(SyncFailure::CursorSet(error)))?;`;
const logCommit = `state
                    .converged
                    .borrow_mut()
                    .entry(stream.clone())
                    .or_default()
                    .extend(entries);`;
const mutations = [
  {
    id: "sync-advances-watermark-before-push-ack",
    needle: `${pushAwait}\n                let mut pushed = state.pushed.borrow_mut();\n                *pushed.entry(stream.clone()).or_default() += tail.len();`,
    replacement: `*state.pushed.borrow_mut().entry(stream.clone()).or_default() += tail.len();\n                ${pushAwait}`,
  },
  {
    id: "sync-resets-incremental-pushed-count",
    needle: "*pushed.entry(stream.clone()).or_default() += tail.len();",
    replacement: "*pushed.entry(stream.clone()).or_default() = tail.len();",
  },
  {
    id: "remote-repulls-the-cursor-entry",
    needle: "(seq > since).then(|| {",
    replacement: "(seq >= since).then(|| {",
  },
  {
    id: "sync-commits-log-after-cursor-ack",
    needle: `${logCommit}\n                ${cursorCommit}`,
    replacement: `${cursorCommit.replace(".set(stream, seq)", ".set(stream.clone(), seq)")}\n                ${logCommit}`,
  },
];
function controls(cases: Case[], expected: unknown[]) {
  return mutations.map((mutation) => {
    const temporary = mkdtempSync(
        join(tmpdir(), "demlik-journal-remote-control-"),
      ),
      file = "crates/tea/src/journal/remote.rs",
      before = digest(file);
    try {
      for (const manifest of ["Cargo.toml", "Cargo.lock"])
        cpSync(manifest, join(temporary, manifest));
      cpSync("crates", join(temporary, "crates"), {
        recursive: true,
        filter: (path) =>
          !path
            .split(sep)
            .some((part) => ["target", "node_modules", ".git"].includes(part)),
      });
      if (existsSync(".cargo"))
        cpSync(".cargo", join(temporary, ".cargo"), { recursive: true });
      const mutant = join(temporary, file),
        source = readFileSync(mutant, "utf8");
      assert.equal(digest(mutant), before);
      assert.equal(source.split(mutation.needle).length, 2, mutation.id);
      writeFileSync(
        mutant,
        source.replace(mutation.needle, mutation.replacement),
      );
      const target = join(temporary, "target");
      process.stderr.write(`Compiling remote-journal control ${mutation.id}\n`);
      build(temporary, target);
      const executable = binary(temporary, target),
        results = native(cases, executable);
      assert.equal(results.length, cases.length);
      const detectedIds = cases
        .filter((_, index) => {
          try {
            assert.deepEqual(results[index].comparison, expected[index]);
            return false;
          } catch {
            return true;
          }
        })
        .map((item) => item.id);
      assert(detectedIds.length, mutation.id);
      assert.equal(digest(file), before);
      return {
        id: mutation.id,
        isolation: "disposable-source-copy",
        sourceBeforeSha256: before,
        mutantSourceSha256: digest(mutant),
        nativeBinarySha256: digest(executable),
        activeSourceUnchanged: true,
        detectedIds,
      };
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      assert.equal(digest(file), before);
    }
  });
}
export async function verifyJournalRemote(
  reportPath = "target/parity/journal-remote.json",
  binaryOverride?: string,
  mutationCheck = false,
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  if (!binaryOverride) build();
  const executable = binaryOverride ?? binary(),
    cases = journalRemoteCases();
  const source: Awaited<ReturnType<typeof executeJournalRemote>>[] = [];
  for (const item of cases)
    source.push(await executeJournalRemote(item.script));
  const expected = source.map((value) => value.comparison),
    results = native(cases, executable);
  assert.equal(results.length, cases.length);
  const failures = cases.flatMap((item, index) => {
    try {
      assert.deepEqual(results[index].comparison, expected[index]);
      return [];
    } catch (error) {
      return [
        {
          id: item.id,
          reference: expected[index],
          native: results[index].comparison,
          message: String(error),
        },
      ];
    }
  });
  const row = (id: string, position: number) => {
    const index = cases.findIndex((item) => item.id === `journal.remote.${id}`);
    assert(index >= 0);
    return z
      .object({
        result: z.object({ ok: z.boolean(), value: z.unknown().optional() }),
      })
      .parse(expected[index][position]).result;
  };
  const seqs = (value: unknown) =>
    z
      .array(z.object({ seq: z.number() }))
      .parse(value)
      .map((value) => value.seq);
  assert.deepEqual(seqs(row("offline-two-clients", 7).value), [1, 2]);
  assert.deepEqual(seqs(row("restart-true-true", 7).value), [2]);
  assert.deepEqual(
    seqs(row("overlapping-cursor-reads", 2).value),
    [1, 2, 1, 2],
  );
  assert.deepEqual(row("overlapping-cursor-reads", 4).value, []);
  assert.equal(row("failure-cursorSet-before-0", 2).ok, false);
  assert.deepEqual(seqs(row("failure-cursorSet-before-0", 4).value), [1]);
  assert.deepEqual(seqs(row("failure-cursorSet-before-0", 12).value), [1, 1]);
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  const report = {
    scope: "native journal sync clients; full port remains incomplete",
    comparison:
      "action-boundary results, exact transport/local/cursor call order and raw failures, typed phases, record/token/entry identity, held writes/reads, restart and racing-sync quirks",
    qualifications: [
      "Native LocalSet receipts are collected in submission order while source uses Promise.all for batches/overlap; these controlled traces do not prove arbitrary Ready-future, join/select or custom-executor continuation order.",
      "The held transport adapter models its own source helper await with an explicit yield; Journal and SyncClient have no production scheduling calibration.",
    ],
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      rustc: command(rustc, ["--version"]).trim(),
    },
    sourceSha256: {
      remote: digest("packages/tea/src/internal/journal/remote.ts"),
      journal: digest("packages/tea/src/internal/journal/index.ts"),
    },
    binary: { path: executable, sha256: digest(executable) },
    compared: cases.length,
    passed: cases.length - failures.length,
    actions: cases.reduce((sum, item) => sum + item.script.actions.length, 0),
    failures,
    controls:
      mutationCheck && !failures.length ? controls(cases, expected) : [],
    cases: cases.map((item, index) => ({
      ...item,
      ...results[index],
      equal: !failures.some((failure) => failure.id === item.id),
      source: source[index],
      functions: [...new Set(results[index].observedRustCalls)].sort(),
    })),
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      report: { type: "string" },
      "native-binary": { type: "string" },
      "mutation-check": { type: "boolean", default: false },
    },
    strict: true,
  });
  const report = await verifyJournalRemote(
    values.report,
    values["native-binary"],
    values["mutation-check"],
  );
  console.log(
    JSON.stringify({
      compared: report.compared,
      actions: report.actions,
      failures: report.failures.length,
      controls: report.controls.map((control) => ({
        id: control.id,
        detected: control.detectedIds.length,
      })),
      report: values.report ?? "target/parity/journal-remote.json",
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
