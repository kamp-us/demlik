import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  type Journal,
  memoryJournal,
} from "../../packages/tea/src/internal/journal/index.js";
import { fileJournal } from "../../packages/tea/src/node/index.js";
import { createCheckWorktree } from "./check-worktree.mjs";
import { buildParityBinary } from "./tea-example.mjs";
import { decode, normalize } from "./timing-clock.mts";

const data = z
  .unknown()
  .refine(
    (value) => z.json().safeParse(value).success,
    "expected encoded JSON data",
  );
const text = z.union([
  z.string(),
  z.object({ $utf16: z.array(z.number().int().min(0).max(65535)) }).strict(),
]);
const effect = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok") }).strict(),
  z.object({ kind: z.literal("error"), value: data }).strict(),
]);
const change = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("on"), listener: z.string(), handle: z.string() })
    .strict(),
  z.object({ op: z.literal("off"), handle: z.string() }).strict(),
]);
const listener = z
  .object({
    id: z.string(),
    first: z.array(change),
    failure: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("throw"), error: data }).strict(),
    ]),
  })
  .strict();
const parser = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("identity") }).strict(),
  z.object({ kind: z.literal("wrap") }).strict(),
  z.object({ kind: z.literal("refuseNull"), issue: data }).strict(),
]);
const action = z.discriminatedUnion("op", [
  z
    .object({
      op: z.enum(["append", "peerAppend", "submit"]),
      stream: text,
      record: z.string(),
      receipt: z.string(),
    })
    .strict(),
  z.object({ op: z.enum(["await", "forget"]), receipt: z.string() }).strict(),
  z.object({ op: z.literal("list"), stream: text }).strict(),
  z
    .object({ op: z.literal("prefix"), stream: text, record: z.string() })
    .strict(),
  z
    .object({
      op: z.literal("batch"),
      stream: text,
      records: z.array(z.string()),
    })
    .strict(),
  z.object({ op: z.literal("push"), record: z.string(), value: data }).strict(),
  z
    .object({ op: z.literal("on"), listener: z.string(), handle: z.string() })
    .strict(),
  z.object({ op: z.literal("off"), handle: z.string() }).strict(),
  z.object({ op: z.literal("restart") }).strict(),
  z
    .object({
      op: z.literal("seed"),
      filename: z.enum(["s.jsonl", "s.jsonl.lock"]),
      contents: z.string(),
    })
    .strict(),
  z.object({ op: z.literal("bytes"), filename: z.literal("s.jsonl") }).strict(),
  z
    .object({
      op: z.literal("held"),
      stream: text,
      peer: z.boolean(),
      nested: z.boolean(),
      first: z.string(),
      second: z.string(),
      outcome: effect,
    })
    .strict(),
  z.object({ op: z.literal("lockError"), stream: text, error: data }).strict(),
]);
export const journalScript = z
  .object({
    adapter: z.enum(["memory", "file"]),
    parse: parser,
    records: z.array(z.object({ id: z.string(), value: data }).strict()),
    listeners: z.array(listener),
    actions: z.array(action),
  })
  .strict();
type Script = z.infer<typeof journalScript>;
function failure(value: unknown): unknown {
  if (value instanceof SyntaxError) return { kind: "syntax" };
  if (value instanceof URIError) return { kind: "uri", message: value.message };
  if (value instanceof Error && "code" in value)
    return { kind: "io", code: value.code };
  if (value instanceof Error)
    return { kind: "error", name: value.name, message: value.message };
  return normalize(value);
}
export async function executeJournal(input: unknown): Promise<unknown> {
  const script = journalScript.parse(input),
    directory = mkdtempSync(join(tmpdir(), "demlik-journal-reference-"));
  const records = new Map(
    script.records.map((record) => [record.id, decode(record.value)]),
  );
  const events: unknown[] = [],
    parses: unknown[] = [],
    diagnostics: unknown[] = [],
    rows: unknown[] = [];
  const pending = new Map<string, Promise<unknown>>(),
    handles = new Map<string, () => void>();
  const callbacks = new Map<
    string,
    (entry: Parameters<Parameters<Journal<unknown>["changes"]>[0]>[0]) => void
  >();
  const calls = new Map<string, number>();
  const parse = (raw: unknown): unknown => {
    parses.push(normalize(raw));
    switch (script.parse.kind) {
      case "identity":
        return raw;
      case "wrap":
        return { wrapped: raw };
      case "refuseNull":
        if (raw === undefined || raw === null) throw decode(script.parse.issue);
        return raw;
    }
  };
  const make = () =>
    script.adapter === "memory"
      ? memoryJournal<unknown>()
      : fileJournal(directory, parse);
  let journal = make();
  function on(listener: string, handle: string) {
    const callback = callbacks.get(listener);
    assert(callback, listener);
    handles.set(handle, journal.changes(callback));
  }
  function off(handle: string) {
    const unsubscribe = handles.get(handle);
    assert(unsubscribe, handle);
    unsubscribe();
  }
  for (const cfg of script.listeners) {
    callbacks.set(cfg.id, (entry) => {
      const count = (calls.get(cfg.id) ?? 0) + 1;
      calls.set(cfg.id, count);
      events.push({
        listener: cfg.id,
        call: count,
        stream: normalize(entry.stream),
        seq: normalize(entry.seq),
        record: normalize(entry.record),
      });
      if (count === 1)
        for (const item of cfg.first) {
          if (item.op === "on") on(item.listener, item.handle);
          else off(item.handle);
        }
      if (cfg.failure.kind === "throw") throw decode(cfg.failure.error);
    });
  }
  function getRecord(id: string) {
    assert(records.has(id), id);
    return records.get(id);
  }
  const settle = (task: Promise<unknown>) =>
    task.then(
      (value) => ({ ok: true, value: normalize(value) }),
      (error) => {
        diagnostics.push(
          error instanceof Error
            ? { name: error.name, message: error.message }
            : normalize(error),
        );
        return { ok: false, error: failure(error) };
      },
    );
  const entries = (values: Awaited<ReturnType<Journal<unknown>["list"]>>) =>
    values.map((entry) => ({
      stream: normalize(entry.stream),
      seq: normalize(entry.seq),
      record: normalize(entry.record),
    }));
  try {
    for (const action of script.actions) {
      let value: unknown, result: unknown;
      try {
        switch (action.op) {
          case "append":
            value = await journal.append(
              String(decode(action.stream)),
              getRecord(action.record),
            );
            break;
          case "peerAppend":
            value = await make().append(
              String(decode(action.stream)),
              getRecord(action.record),
            );
            break;
          case "submit":
            pending.set(
              action.receipt,
              settle(
                journal.append(
                  String(decode(action.stream)),
                  getRecord(action.record),
                ),
              ),
            );
            break;
          case "await": {
            const task = pending.get(action.receipt);
            assert(task, action.receipt);
            value = await task;
            pending.delete(action.receipt);
            break;
          }
          case "forget":
            pending.delete(action.receipt);
            break;
          case "list":
            value = entries(await journal.list(String(decode(action.stream))));
            break;
          case "prefix": {
            const receipt = settle(
              journal.append(
                String(decode(action.stream)),
                getRecord(action.record),
              ),
            );
            const old = entries(
                await journal.list(String(decode(action.stream))),
              ),
              afterOld = normalize(events);
            const fresh = entries(
                await journal.list(String(decode(action.stream))),
              ),
              afterFresh = normalize(events);
            value = {
              old,
              afterOld,
              fresh,
              afterFresh,
              receipt: await receipt,
            };
            break;
          }
          case "batch":
            value = await Promise.all(
              action.records.map((id) =>
                journal.append(String(decode(action.stream)), getRecord(id)),
              ),
            );
            break;
          case "push": {
            const record = getRecord(action.record);
            assert(Array.isArray(record));
            record.push(decode(action.value));
            break;
          }
          case "on":
            on(action.listener, action.handle);
            break;
          case "off":
            off(action.handle);
            break;
          case "restart":
            journal = make();
            break;
          case "seed":
            assert.equal(script.adapter, "file");
            await writeFile(join(directory, action.filename), action.contents);
            break;
          case "bytes":
            value = await readFile(join(directory, action.filename), "utf8");
            break;
          case "lockError":
            await journal.withLock(String(decode(action.stream)), async () => {
              throw decode(action.error);
            });
            break;
          case "held": {
            const stream = String(decode(action.stream)),
              inside = journal,
              other = action.peer ? make() : journal;
            let entered!: () => void, release!: () => void;
            const held = new Promise<void>((resolve) => {
                entered = resolve;
              }),
              released = new Promise<void>((resolve) => {
                release = resolve;
              });
            const first = settle(
              inside.withLock(stream, async () => {
                entered();
                await released;
                const write = async () => {
                  const result = await inside.append(
                    stream,
                    getRecord(action.first),
                  );
                  return result;
                };
                const result = action.nested
                  ? await inside.withLock(stream, write)
                  : await write();
                if (action.outcome.kind === "error")
                  throw decode(action.outcome.value);
                return result;
              }),
            );
            await held;
            const second = settle(
              other.append(stream, getRecord(action.second)),
            );
            const before = entries(await inside.list(stream)),
              again = entries(await inside.list(stream));
            release();
            value = { before, again, first: await first, second: await second };
            break;
          }
        }
        result = { ok: true, value: normalize(value) };
      } catch (error) {
        diagnostics.push(
          error instanceof Error
            ? { name: error.name, message: error.message }
            : normalize(error),
        );
        result = { ok: false, error: failure(error) };
      }
      rows.push({
        op: action.op,
        result,
        events: normalize(events),
        parses: normalize(parses),
      });
    }
    await Promise.all(pending.values());
    return { comparison: rows, diagnostics };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type Case = { id: string; script: Script };
export function journalCases(): Case[] {
  const cases: Case[] = [];
  const add = (id: string, script: unknown) =>
    cases.push({ id, script: journalScript.parse(script) });
  const records = [
    { id: "r", value: { tag: "one" } },
    { id: "array", value: ["seed"] },
    {
      id: "odd",
      value: {
        $object: [
          ["__proto__", { accepted: true }],
          [{ $utf16: [0xd800] }, { $undefined: true }],
          ["n", { $number: "NaN" }],
          ["z", { $number: "-0" }],
        ],
      },
    },
  ];
  const log = { id: "log", first: [], failure: { kind: "none" } };
  const write = (record = "r", stream: unknown = "s") => ({
    op: "append",
    stream,
    record,
    receipt: "unused",
  });
  const list = (stream: unknown = "s") => ({ op: "list", stream });
  const on = (listener = "log", handle = "off") => ({
    op: "on",
    listener,
    handle,
  });
  const off = (handle = "off") => ({ op: "off", handle });
  const base = (
    adapter: "memory" | "file",
    actions: unknown[],
    extra: Record<string, unknown> = {},
  ) => ({
    adapter,
    parse: { kind: "identity" },
    records,
    listeners: [log],
    actions,
    ...extra,
  });
  for (const adapter of ["memory", "file"] as const) {
    add(
      `journal.${adapter}.order-and-streams`,
      base(adapter, [
        list("never"),
        write(),
        write("array", "two"),
        { op: "batch", stream: "s", records: ["r", "array", "odd", "r"] },
        list(),
        list("two"),
      ]),
    );
    add(
      `journal.${adapter}.reference-and-restart`,
      base(adapter, [
        on(),
        write("array"),
        { op: "push", record: "array", value: "mutated" },
        list(),
        write("odd"),
        list(),
        { op: "restart" },
        list(),
        on("log", "new"),
        off(),
        write(),
        list(),
      ]),
    );
    add(
      `journal.${adapter}.duplicate-and-stale-unsubscribe`,
      base(adapter, [
        on("log", "old"),
        on("log", "duplicate"),
        write(),
        off("duplicate"),
        on("log", "new"),
        off("old"),
        write(),
        on("log", "readded"),
        write(),
        off("old"),
        off("old"),
        write(),
      ]),
    );
    add(
      `journal.${adapter}.live-listener-add-remove`,
      base(
        adapter,
        [
          on("a", "ha"),
          on("b", "hb"),
          write(),
          on("b", "hb2"),
          off("hb"),
          write(),
          off("ha"),
          write(),
        ],
        {
          listeners: [
            {
              id: "a",
              first: [
                { op: "off", handle: "hb" },
                { op: "on", listener: "c", handle: "hc" },
              ],
              failure: { kind: "none" },
            },
            { id: "b", first: [], failure: { kind: "none" } },
            { id: "c", first: [], failure: { kind: "none" } },
          ],
        },
      ),
    );
    add(
      `journal.${adapter}.self-remove-readd-live-set`,
      base(adapter, [on("self", "old"), write(), write()], {
        listeners: [
          {
            id: "self",
            first: [
              { op: "off", handle: "old" },
              { op: "on", listener: "self", handle: "new" },
            ],
            failure: { kind: "none" },
          },
        ],
      }),
    );
    for (const [index, error] of [
      { _tag: "listener_failed", code: 7 },
      "broken",
      null,
      { $undefined: true },
      { $number: "NaN" },
    ].entries())
      add(
        `journal.${adapter}.failed-listener-${index}`,
        base(
          adapter,
          [
            on("fail", "bad"),
            on("log", "tail"),
            write(),
            list(),
            off("bad"),
            write(),
            list(),
          ],
          {
            listeners: [
              { id: "fail", first: [], failure: { kind: "throw", error } },
              log,
            ],
          },
        ),
      );
    add(
      `journal.${adapter}.held-independent-and-nested`,
      base(adapter, [
        on(),
        {
          op: "held",
          stream: "s",
          peer: false,
          nested: true,
          first: "r",
          second: "array",
          outcome: { kind: "ok" },
        },
        list(),
      ]),
    );
    add(
      `journal.${adapter}.held-error-keeps-appended-record`,
      base(adapter, [
        {
          op: "held",
          stream: "s",
          peer: false,
          nested: false,
          first: "r",
          second: "array",
          outcome: {
            kind: "error",
            value: { _tag: "effect_failed", at: "after append" },
          },
        },
        list(),
        { op: "lockError", stream: "s", error: { $undefined: true } },
        write(),
        list(),
      ]),
    );
    add(
      `journal.${adapter}.peer-instance-changes`,
      base(adapter, [
        on(),
        { op: "peerAppend", stream: "s", record: "r", receipt: "unused" },
        list(),
        write(),
        list(),
      ]),
    );
    add(
      `journal.${adapter}.ignored-receipt-work-continues`,
      base(adapter, [
        { op: "submit", stream: "s", record: "r", receipt: "first" },
        { op: "forget", receipt: "first" },
        list(),
        list(),
        write("array"),
        list(),
      ]),
    );
  }
  add(
    "journal.memory.ready-prefix-and-listener-turns",
    base("memory", [on(), { op: "prefix", stream: "s", record: "r" }]),
  );
  add(
    "journal.file.held-cross-instance",
    base("file", [
      on(),
      {
        op: "held",
        stream: "s",
        peer: true,
        nested: true,
        first: "r",
        second: "array",
        outcome: { kind: "ok" },
      },
      list(),
      { op: "restart" },
      list(),
    ]),
  );
  add(
    "journal.file.record-parse-transforms-old-rewrites",
    base(
      "file",
      [
        write(),
        write("array"),
        list(),
        { op: "bytes", filename: "s.jsonl" },
        { op: "restart" },
        list(),
      ],
      { parse: { kind: "wrap" } },
    ),
  );
  const recovery = [
    [
      "missing-null-text",
      '{"record":"missing-seq"}\n{"seq":null,"record":"null-seq"}\n{"seq":"legacy","record":"text-seq"}\n',
    ],
    [
      "non-gap-numbers",
      '{"seq":100,"record":"a"}\n{"seq":-2,"record":"b"}\n{"seq":1.5,"record":"c"}\n',
    ],
    [
      "overflow-and-negative-zero",
      '{"seq":1e400,"record":"a"}\n{"seq":-0,"record":"b"}\n',
    ],
    [
      "structured-metadata",
      '{"seq":false,"record":1}\n{"seq":[1,null],"record":2}\n{"seq":{"__proto__":true},"record":3}\n',
    ],
    ["missing-record", '{"seq":17}\n'],
    ["primitive-envelopes", '3\n[]\n"row"\ntrue\n'],
    ["empty-lines", '\n{"seq":9,"record":"a"}\n\n'],
  ];
  for (const [name, contents] of recovery)
    add(
      `journal.file.recovery-${name}`,
      base("file", [
        { op: "seed", filename: "s.jsonl", contents },
        list(),
        write(),
        { op: "bytes", filename: "s.jsonl" },
        { op: "restart" },
        list(),
      ]),
    );
  for (const [name, contents] of [
    ["null-envelope", "null\n"],
    ["syntax", "{broken}\n"],
    ["whitespace", " \n"],
  ])
    add(
      `journal.file.failure-${name}`,
      base("file", [
        { op: "seed", filename: "s.jsonl", contents },
        list(),
        write(),
        { op: "bytes", filename: "s.jsonl" },
      ]),
    );
  for (const [name, contents] of [
    ["null", '{"seq":1,"record":null}\n'],
    ["missing", '{"seq":1}\n'],
  ])
    add(
      `journal.file.parse-refusal-${name}`,
      base(
        "file",
        [
          { op: "seed", filename: "s.jsonl", contents },
          list(),
          write(),
          { op: "bytes", filename: "s.jsonl" },
          { op: "restart" },
          list(),
        ],
        {
          parse: {
            kind: "refuseNull",
            issue: { _tag: "record_refused", detail: "expected stored value" },
          },
        },
      ),
    );
  add(
    "journal.file.dead-pid-lock",
    base("file", [
      { op: "seed", filename: "s.jsonl.lock", contents: "2147483647" },
      write(),
      list(),
    ]),
  );
  add(
    "journal.file.stream-uri-and-unpaired-refusal",
    base("file", [
      write("r", "a/b +!😀"),
      list("a/b +!😀"),
      write("r", { $utf16: [0xd800] }),
      list({ $utf16: [0xd800] }),
      write("odd"),
      { op: "bytes", filename: "s.jsonl" },
      list(),
    ]),
  );
  for (let run = 0; run < 24; run++) {
    const adapter = run % 2 === 0 ? "memory" : "file",
      actions: unknown[] = [on()];
    for (let step = 0; step < 9; step++) {
      const stream = (run + step) % 3 === 0 ? "two" : "s";
      if (step === 3)
        actions.push({ op: "push", record: "array", value: { run } });
      if (step === 5)
        actions.push({ op: "restart" }, on("log", `restarted-${run}`));
      actions.push(write(["r", "array", "odd"][(run + step) % 3], stream));
      if (step % 3 === 0) actions.push(list(stream));
    }
    actions.push(
      { op: "batch", stream: "s", records: ["r", "array", "odd"] },
      list(),
      list("two"),
    );
    if (adapter === "file") actions.push({ op: "bytes", filename: "s.jsonl" });
    add(`journal.generated-${run}`, base(adapter, actions));
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
    cwd,
    env,
    input,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    timeout: 300000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${executable} failed: ${result.stderr.slice(-10000)}`,
  );
  return result.stdout;
}
function binary(cwd = process.cwd(), target = process.env.CARGO_TARGET_DIR) {
  return join(
    target ? resolve(cwd, target) : join(cwd, "target"),
    "debug/journal_driver",
  );
}
function build(cwd = process.cwd(), target?: string) {
  command(
    process.env.CARGO ?? "cargo",
    ["build", "--locked", "-p", "demlik-parity", "--bin", "journal_driver"],
    undefined,
    cwd,
    {
      ...process.env,
      CARGO_NET_OFFLINE: "true",
      CARGO_PROFILE_DEV_DEBUG: "0",
      CARGO_PROFILE_TEST_DEBUG: "0",
      CARGO_INCREMENTAL: "0",
      CARGO_BUILD_JOBS: "1",
      ...(target ? {} : {}),
    },
  );
}
const response = z
  .object({
    comparison: z.array(z.unknown()),
    diagnostics: z.array(z.unknown()),
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
const mutations = [
  {
    id: "journal-skips-in-process-exclusion",
    file: "crates/tea/src/journal/mod.rs",
    needle:
      "let previous = self.tails.borrow_mut().insert(stream.clone(), tail);",
    replacement:
      "let _previous = self.tails.borrow_mut().insert(stream.clone(), tail); let previous = None::<oneshot::Receiver<()>>;",
  },
  {
    id: "journal-swallows-listener-failure",
    file: "crates/tea/src/journal/mod.rs",
    needle: "listeners.for_each(|listener| listener(&entry));",
    replacement: "listeners.fanout(|listener| listener(&entry), |_| {});",
  },
  {
    id: "journal-derives-next-seq-from-last-metadata",
    file: "crates/tea/src/journal/file.rs",
    needle: "seq: ((entries.len() + 1) as f64).into(),",
    replacement:
      "seq: (entries.last().and_then(|entry| entry.seq.number()).unwrap_or(0.0) + 1.0).into(),",
  },
  {
    id: "journal-skips-file-lock",
    file: "crates/tea/src/journal/file.rs",
    needle: "acquire_file_lock(&self.directory, &path).await?;",
    replacement: "let _ = (&self.directory, &path);",
  },
];
function controls(cases: Case[], expected: unknown[]) {
  return mutations.map((mutation) => {
    const mutationCheck = createCheckWorktree(process.cwd(), "journal");
    let mutationFailure: unknown;
    try {
      const temporary = mutationCheck.root,
        before = digest(mutation.file);
      try {
        const file = join(temporary, mutation.file),
          source = readFileSync(file, "utf8");
        assert.equal(digest(file), before);
        assert.equal(source.split(mutation.needle).length, 2, mutation.id);
        writeFileSync(
          file,
          source.replace(mutation.needle, mutation.replacement),
        );
        const target = join(temporary, "target");
        process.stderr.write(`Compiling journal control ${mutation.id}\n`);
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
        assert(detectedIds.length > 0, mutation.id);
        assert.equal(digest(mutation.file), before);
        return {
          id: mutation.id,
          isolation: "registered-worktree-default-target",
          sourceBeforeSha256: before,
          mutantSourceSha256: digest(file),
          nativeBinarySha256: digest(executable),
          activeSourceUnchanged: true,
          detectedIds,
        };
      } finally {
        assert.equal(digest(mutation.file), before);
      }
    } catch (error) {
      mutationFailure = error;
      throw error;
    } finally {
      mutationCheck.remove(mutationFailure);
    }
  });
}
export async function verifyJournal(
  reportPath = "target/parity/journal.json",
  binaryOverride?: string,
  mutationCheck = false,
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  let producer: ReturnType<typeof buildParityBinary> | null = null;
  let executable: string;
  if (binaryOverride) {
    executable = binaryOverride;
  } else {
    producer = buildParityBinary(
      process.env.CARGO ?? "cargo",
      "journal_driver",
      reportPath,
    );
    executable = binaryOverride ?? producer.binary;
  }
  const cases = journalCases();
  const source: unknown[] = [];
  for (const item of cases) source.push(await executeJournal(item.script));
  const expected = source.map(
      (value) =>
        z.object({ comparison: z.array(z.unknown()) }).parse(value).comparison,
    ),
    results = native(cases, executable);
  assert.equal(results.length, cases.length);
  const failures: {
    id: string;
    reference: unknown;
    native: unknown;
    message: string;
  }[] = [];
  const equal = cases.map((item, index) => {
    try {
      assert.deepEqual(results[index].comparison, expected[index], item.id);
      return true;
    } catch (error) {
      failures.push({
        id: item.id,
        reference: expected[index],
        native: results[index].comparison,
        message: String(error),
      });
      return false;
    }
  });
  const row = (id: string, position: number) => {
    const index = cases.findIndex((item) => item.id === id);
    assert(index >= 0);
    return expected[index][position];
  };
  const ready = z
    .object({
      result: z.object({
        value: z.object({
          old: z.array(z.unknown()),
          fresh: z.array(z.unknown()),
          afterOld: z.array(z.unknown()),
          afterFresh: z.array(z.unknown()),
        }),
      }),
    })
    .parse(row("journal.memory.ready-prefix-and-listener-turns", 1))
    .result.value;
  assert.equal(ready.old.length, 0);
  assert.equal(ready.fresh.length, 1);
  assert.equal(ready.afterOld.length, 0);
  assert.equal(ready.afterFresh.length, 1);
  const recovery = z
    .object({ result: z.object({ value: z.object({ seq: z.number() }) }) })
    .parse(row("journal.file.recovery-missing-null-text", 2));
  assert.equal(recovery.result.value.seq, 4);
  const failureRow = z
    .object({ result: z.object({ ok: z.boolean() }) })
    .parse(row("journal.memory.failed-listener-0", 2));
  assert.equal(failureRow.result.ok, false);
  const persisted = z
    .object({ result: z.object({ value: z.array(z.unknown()) }) })
    .parse(row("journal.memory.failed-listener-0", 3));
  assert.equal(persisted.result.value.length, 1);
  const cargo = process.env.CARGO ?? "cargo",
    rustc =
      process.env.RUSTC ??
      (isAbsolute(cargo) ? join(dirname(cargo), "rustc") : "rustc");
  const report = {
    producer,
    scope:
      "native ordered memory and file journals; full port remains incomplete",
    comparison:
      "action-boundary values, live listener traces, parser calls, ready-await prefixes, and exact JSONL bytes; raw platform parser/IO diagnostics retained separately",
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      rustc: command(rustc, ["--version"]).trim(),
    },
    sourceSha256: {
      journal: digest("packages/tea/src/internal/journal/index.ts"),
      node: digest("packages/tea/src/node/index.ts"),
    },
    binary: { path: executable, sha256: digest(executable) },
    compared: cases.length,
    passed: equal.filter(Boolean).length,
    failures,
    qualifications: [
      "Component request/receipt boundaries are paired. Arbitrary join!, select! and custom-executor continuation ordering remain unverified; the native batch collector awaits receipts in submission order.",
      "Parser and filesystem failure data is retained. Identical platform diagnostic wording is not verified.",
    ],
    actions: cases.reduce((sum, item) => sum + item.script.actions.length, 0),
    controls:
      mutationCheck && !failures.length ? controls(cases, expected) : [],
    cases: cases.map((item, index) => ({
      ...item,
      ...results[index],
      equal: equal[index],
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
  const report = await verifyJournal(
    values.report,
    values["native-binary"],
    values["mutation-check"],
  );
  console.log(
    JSON.stringify({
      compared: report.compared,
      actions: report.actions,
      controls: report.controls.map((control) => ({
        id: control.id,
        detected: control.detectedIds.length,
      })),
      report: values.report ?? "target/parity/journal.json",
    }),
  );
  if (report.failures.length) process.exitCode = 1;
}
