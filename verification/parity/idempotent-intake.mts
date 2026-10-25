import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  createIntake,
  type IntakeCmd,
  type IntakeState,
  intakeProcessDef,
  intakeReplayDef,
} from "../../packages/tea/src/idempotency/index.js";
import { Outcome } from "../../packages/tea/src/index.js";
import { queueAdapter } from "../../packages/tea/src/internal/work-queue/adapter.js";
import { cmdEdgeOver, followUps } from "../../packages/tea/src/pure/core.js";
import { decode, errorValue, normalize, numeric } from "./timing-clock.mts";

const num = z.union([
  z.number(),
  z
    .object({ $number: z.enum(["NaN", "Infinity", "-Infinity", "-0"]) })
    .strict(),
]);
const at = num.nullable();
const text = z.union([
  z.string(),
  z.object({ $utf16: z.array(z.number().int().min(0).max(65535)) }).strict(),
]);
const data = z
  .unknown()
  .refine((v) => z.json().safeParse(v).success, "encoded JSON data");
const action = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("bind"),
      kind: z.enum(["payload", "result"]),
      slot: z.string(),
      value: data,
    })
    .strict(),
  z
    .object({
      op: z.literal("mutate"),
      kind: z.enum(["payload", "result"]),
      slot: z.string(),
      value: data,
    })
    .strict(),
  z
    .object({ op: z.literal("receive"), slot: z.string(), at, id: text })
    .strict(),
  z
    .object({ op: z.literal("complete"), key: text, slot: z.string(), at })
    .strict(),
  z.object({ op: z.literal("claim"), at }).strict(),
  z.object({ op: z.enum(["boot", "roundTrip"]) }).strict(),
  z.object({ op: z.literal("restore"), encoded: z.string() }).strict(),
  z.object({ op: z.literal("markDone"), id: text }).strict(),
  z.object({ op: z.literal("failKey"), enabled: z.boolean() }).strict(),
  z
    .object({
      op: z.literal("build"),
      family: z.enum(["process", "replay"]),
      key: text,
      slot: z.string(),
      id: text.optional(),
    })
    .strict(),
  z.object({ op: z.literal("settle"), output: data, at: num }).strict(),
]);
export const intakeScript = z
  .object({
    ttlMs: num.optional(),
    constantKey: text.optional(),
    actions: z.array(action),
  })
  .strict();
type Script = z.infer<typeof intakeScript>;
type Stamp = z.infer<typeof at>;
type ActionInput = z.input<typeof action>;
const stored = z
  .object({
    seen: z
      .object({
        entries: z.record(
          z.string(),
          z
            .object({
              value: z.discriminatedUnion("phase", [
                z.object({ phase: z.literal("pending") }).passthrough(),
                z
                  .object({
                    phase: z.literal("done"),
                    result: z.unknown().optional(),
                  })
                  .passthrough(),
              ]),
              atMs: z.number().nullable(),
            })
            .passthrough(),
        ),
        order: z.array(z.string()),
        capacity: z.number().nullable().optional(),
        ttlMs: z.number().nullable().optional(),
      })
      .passthrough(),
    queue: z.array(
      z
        .object({
          id: z.string(),
          status: z.enum(["pending", "running", "done", "failed", "cancelled"]),
          input: z.unknown().optional(),
          enqueuedAt: z.number().nullable(),
          startedAt: z.number().nullable().optional(),
          finishedAt: z.number().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
function stamp(value: z.infer<typeof at>): number {
  // A numeric Msg can be JSON-restored as null. Reflect keeps that deliberate
  // boundary visible without claiming nonnumeric authored clocks are typed.
  const holder = { at: 0 };
  Reflect.set(holder, "at", value === null ? null : numeric.parse(value));
  return holder.at;
}
export function executeIntake(raw: unknown) {
  const script = intakeScript.parse(raw);
  let keyCalls = 0,
    failKey = false;
  const keyInputs: unknown[] = [];
  const keyFailure = {
    name: "Error",
    message: "key rejected",
    capability: () => 7,
  };
  const constantKey =
    script.constantKey === undefined
      ? undefined
      : z.string().parse(decode(script.constantKey));
  const intake = createIntake<unknown, unknown>({
    keyOf: (payload) => {
      keyCalls++;
      keyInputs.push(normalize(payload));
      if (failKey) throw keyFailure;
      if (constantKey !== undefined) return constantKey;
      const key =
        typeof payload === "object" && payload !== null
          ? Reflect.get(payload, "key")
          : undefined;
      if (typeof key !== "string")
        throw new TypeError("fixture payload requires a text key");
      return key;
    },
    ...(script.ttlMs === undefined
      ? {}
      : { ttlMs: numeric.parse(script.ttlMs) }),
  });
  let state = intake.init();
  const payloads = new Map<string, unknown>(),
    results = new Map<string, unknown>();
  let last: IntakeCmd<unknown, unknown> | undefined;
  const row = (effect: unknown) => ({
    wireState: normalize(JSON.parse(JSON.stringify(state))),
    values: {
      entries: normalize(state.seen.entries),
      entryKeys: Object.keys(state.seen.entries).map(normalize),
      order: normalize(state.seen.order),
      capacity: normalize(state.seen.capacity),
      ttlMs: normalize(state.seen.ttlMs),
      queue: normalize(state.queue),
    },
    effect,
    keyCalls,
    keyInputs: [...keyInputs],
  });
  const identity = (value: unknown, registry: Map<string, unknown>) =>
    value !== null && typeof value === "object"
      ? [...registry]
          .filter(([, v]) => v === value)
          .map(([key]) => key)
          .sort()
      : [];
  const rows = [row(null)];
  for (const action of script.actions) {
    const before = state;
    let effect: Record<string, unknown> = {};
    try {
      switch (action.op) {
        case "bind":
          (action.kind === "payload" ? payloads : results).set(
            action.slot,
            decode(action.value),
          );
          break;
        case "mutate": {
          const value = (action.kind === "payload" ? payloads : results).get(
            action.slot,
          );
          const replacement = decode(action.value);
          assert(value !== null && typeof value === "object");
          assert(replacement !== null && typeof replacement === "object");
          for (const key of Object.keys(value))
            Reflect.deleteProperty(value, key);
          for (const [key, item] of Object.entries(replacement))
            Object.defineProperty(value, key, {
              value: item,
              writable: true,
              configurable: true,
              enumerable: true,
            });
          break;
        }
        case "receive": {
          const [next, commands] = intake.receive(
            state,
            payloads.get(action.slot),
            stamp(action.at),
            z.string().parse(decode(action.id)),
          );
          effect = {
            commands: normalize(commands),
            identities: commands.map((c) =>
              c.type === "intake:process"
                ? identity(c.payload, payloads)
                : identity(c.result, results),
            ),
          };
          last = commands.at(-1);
          state = next;
          break;
        }
        case "complete": {
          const [next, commands] = intake.complete(
            state,
            z.string().parse(decode(action.key)),
            results.get(action.slot),
            stamp(action.at),
          );
          effect = { commands: normalize(commands) };
          state = next;
          break;
        }
        case "claim": {
          const claim = intake.claimNext(state, stamp(action.at));
          if (claim) {
            state = claim.state;
            effect = {
              claimed: normalize(claim.claimed),
              identities: identity(claim.claimed.input, payloads),
            };
          } else effect = { claimed: null };
          break;
        }
        case "boot": {
          const [next, commands] = intake.boot(state);
          effect = { commands: normalize(commands) };
          state = next;
          break;
        }
        case "roundTrip":
        case "restore": {
          const raw: unknown = JSON.parse(
            action.op === "restore" ? action.encoded : JSON.stringify(state),
          );
          stored.parse(raw);
          const holder: { state: IntakeState<unknown, unknown> } = { state };
          Reflect.set(holder, "state", raw);
          state = holder.state;
          effect = { restored: true };
          break;
        }
        case "markDone": {
          const change = queueAdapter<unknown>().markDone(
            state.queue,
            z.string().parse(decode(action.id)),
          );
          effect = { changed: change.changed };
          state = { ...state, queue: change.next };
          break;
        }
        case "failKey":
          failKey = action.enabled;
          break;
        case "build": {
          const key = z.string().parse(decode(action.key));
          last =
            action.family === "process"
              ? intakeProcessDef<unknown>()({
                  key,
                  itemId:
                    action.id === undefined
                      ? "built"
                      : z.string().parse(decode(action.id)),
                  payload: payloads.get(action.slot),
                })
              : intakeReplayDef<unknown>()({
                  key,
                  result: results.get(action.slot),
                });
          effect = { command: normalize(last) };
          break;
        }
        case "settle": {
          assert(last);
          const edge = cmdEdgeOver(
            [intakeProcessDef<unknown>(), intakeReplayDef<unknown>()],
            () => numeric.parse(action.at),
          );
          effect = {
            messages: normalize(
              followUps(edge(last, Outcome.ok(decode(action.output)))),
            ),
          };
          last = undefined;
          break;
        }
      }
    } catch (error) {
      effect = {
        error:
          error === keyFailure
            ? {
                name: keyFailure.name,
                message: keyFailure.message,
                sameKeyCause: true,
                capability: keyFailure.capability(),
              }
            : errorValue(error),
      };
    }
    Object.assign(effect, {
      sameState: state === before,
      sameSeen: state.seen === before.seen,
      sameQueue: state.queue === before.queue,
    });
    rows.push(row(effect));
  }
  return rows;
}

export function intakeCases() {
  const cases: { id: string; input: Script }[] = [];
  const add = (
    name: string,
    actions: z.input<typeof action>[],
    options: Omit<Script, "actions"> = {},
  ) =>
    cases.push({
      id: `intake.${name}`,
      input: intakeScript.parse({ ...options, actions }),
    });
  const payload = (
    slot: string,
    key: z.infer<typeof text> = slot,
    value: unknown = 1,
  ): Extract<ActionInput, { op: "bind" }> => ({
    op: "bind",
    kind: "payload",
    slot,
    value: { key, value },
  });
  const result = (
    slot = "r",
    value: unknown = { receipt: 7 },
  ): Extract<ActionInput, { op: "bind" }> => ({
    op: "bind",
    kind: "result",
    slot,
    value,
  });
  const receive = (
    slot: string,
    at: Stamp,
    id = slot,
  ): Extract<ActionInput, { op: "receive" }> => ({
    op: "receive",
    slot,
    at,
    id,
  });
  const complete = (
    key: z.infer<typeof text>,
    at: Stamp,
    slot = "r",
  ): Extract<ActionInput, { op: "complete" }> => ({
    op: "complete",
    key,
    slot,
    at,
  });
  const normal = [payload("a"), result()];
  add(
    "pending-never-expires",
    [
      ...normal,
      receive("a", 0),
      receive("a", 1000000, "dup"),
      receive("a", { $number: "Infinity" }, "inf"),
    ],
    { ttlMs: 10 },
  );
  add(
    "ttl-starts-at-complete",
    [
      ...normal,
      receive("a", 0),
      receive("a", 99, "slow"),
      complete("a", 100),
      receive("a", 109),
      receive("a", 110, "new"),
    ],
    { ttlMs: 10 },
  );
  add("complete-is-cache-only-and-unknown-key", [
    ...normal,
    complete("a", 1),
    receive("a", 2),
    { op: "claim", at: 3 },
  ]);
  add(
    "done-pending-claim",
    [...normal, receive("a", 0), complete("a", 1), { op: "claim", at: 999 }],
    { ttlMs: 1 },
  );
  add("pending-crash-resume", [
    ...normal,
    receive("a", 0),
    { op: "claim", at: 1 },
    { op: "roundTrip" },
    { op: "boot" },
    { op: "claim", at: 2 },
  ]);
  add(
    "done-before-crash",
    [
      ...normal,
      receive("a", 0),
      { op: "claim", at: 1 },
      complete("a", 2),
      { op: "roundTrip" },
      { op: "boot" },
      { op: "claim", at: 100 },
      receive("a", 100, "duplicate"),
    ],
    { ttlMs: 1 },
  );
  add("boot-noop", [
    { op: "boot" },
    ...normal,
    receive("a", 0),
    { op: "boot" },
  ]);
  add("result-identity-and-json-detachment", [
    ...normal,
    receive("a", 0),
    complete("a", 1),
    receive("a", 2),
    { op: "mutate", kind: "result", slot: "r", value: { receipt: 99 } },
    receive("a", 3),
    { op: "roundTrip" },
    { op: "mutate", kind: "result", slot: "r", value: { receipt: 123 } },
    receive("a", 4),
  ]);
  add("payload-identity-and-current-key", [
    ...normal,
    receive("a", 0),
    {
      op: "mutate",
      kind: "payload",
      slot: "a",
      value: { key: "b", value: 42 },
    },
    { op: "claim", at: 1 },
    complete("b", 2),
    { op: "boot" },
    payload("old", "a"),
    receive("old", 9),
  ]);
  add("duplicate-id-claim-first-patch", [
    payload("a"),
    payload("b"),
    result(),
    receive("a", 0, "same"),
    receive("b", 1, "same"),
    complete("a", 2),
    { op: "claim", at: 3 },
    { op: "claim", at: 4 },
    { op: "markDone", id: "same" },
  ]);
  const rawState = (entries: unknown, queue: unknown[]) =>
    JSON.stringify({
      seen: {
        entries,
        order: Object.keys(z.record(z.string(), z.unknown()).parse(entries)),
      },
      queue,
    });
  const queueItem = (key: string, status = "running") => ({
    id: "same",
    status,
    input: { key },
    enqueuedAt: 0,
    startedAt: 1,
  });
  add("duplicate-id-boot-original-iteration", [
    {
      op: "restore",
      encoded: rawState(
        {
          a: { value: { phase: "pending" }, atMs: 0 },
          b: { value: { phase: "pending" }, atMs: 0 },
        },
        [queueItem("a"), queueItem("b")],
      ),
    },
    { op: "boot" },
    { op: "claim", at: 2 },
  ]);
  for (const key of [
    "toString",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "valueOf",
    "__defineGetter__",
  ]) {
    add(`pristine-${key}`, [payload("p", key), receive("p", 0)]);
    add(`completed-${key}`, [
      payload("p", key),
      result(),
      complete(key, 0),
      receive("p", 1),
      { op: "roundTrip" },
      receive("p", 2),
    ]);
  }
  for (const nested of ["value", "atMs", "constructor", "__proto__", "unknown"])
    add(`injected-lookup-${nested}`, [
      result(),
      complete("__proto__", 0),
      payload("p", nested),
      receive("p", 1),
    ]);
  add("spread-resets-injected-prototype", [
    result(),
    complete("__proto__", 0),
    payload("p", "__proto__"),
    receive("p", 1),
    payload("other"),
    receive("other", 2),
    receive("p", 3),
  ]);
  add("json-own-proto-overwrite", [
    {
      op: "restore",
      encoded: rawState(
        Object.fromEntries([
          [
            "__proto__",
            { value: { phase: "done", result: { receipt: 1 } }, atMs: 0 },
          ],
        ]),
        [],
      ),
    },
    payload("p", "__proto__"),
    result(),
    receive("p", 1),
    complete("__proto__", 2),
    receive("p", 3),
  ]);
  add("numeric-key-order", [
    payload("b", "10"),
    payload("a", "2"),
    payload("c", "01"),
    receive("b", 0),
    receive("a", 1),
    receive("c", 2),
    result(),
    complete("10", 3),
    { op: "claim", at: 4 },
  ]);
  add("utf16-keys-and-ids", [
    payload("p", { $utf16: [0xd800] }),
    receive("p", 0),
    result("r", { $utf16: [0xdc00] }),
    complete({ $utf16: [0xd800] }, 1),
    { op: "roundTrip" },
    receive("p", 2),
  ]);
  add("undefined-result-presence", [
    payload("a"),
    result("r", { $undefined: true }),
    receive("a", 0),
    complete("a", 1),
    receive("a", 2),
    { op: "roundTrip" },
    receive("a", 3),
  ]);
  add(
    "undefined-input-presence",
    [
      { op: "bind", kind: "payload", slot: "p", value: { $undefined: true } },
      receive("p", 0),
      { op: "claim", at: 1 },
      { op: "roundTrip" },
      { op: "boot" },
      { op: "claim", at: 2 },
    ],
    { constantKey: "undefined-payload" },
  );
  add(
    "present-null-input-and-result",
    [
      { op: "bind", kind: "payload", slot: "p", value: null },
      result("r", null),
      receive("p", 0),
      complete("n", 1),
      { op: "roundTrip" },
      receive("p", 2),
    ],
    { constantKey: "n" },
  );
  add("key-callback-failure-is-atomic", [
    ...normal,
    { op: "failKey", enabled: true },
    receive("a", 0),
    { op: "failKey", enabled: false },
    receive("a", 1),
    { op: "claim", at: 2 },
    { op: "failKey", enabled: true },
    { op: "boot" },
    { op: "claim", at: 3 },
  ]);
  add("key-callback-original-cause-all-verbs", [
    ...normal,
    receive("a", 0),
    { op: "claim", at: 1 },
    payload("b"),
    receive("b", 2),
    { op: "failKey", enabled: true },
    { op: "boot" },
    { op: "claim", at: 3 },
    receive("a", 4),
  ]);
  add("injected-null-timestamp", [
    result(),
    complete("__proto__", null),
    payload("p", "atMs"),
    receive("p", 1),
  ]);
  add("restored-store-ttl-delegation", [
    {
      op: "restore",
      encoded: JSON.stringify({
        seen: {
          entries: { a: { value: { phase: "pending" }, atMs: 0 } },
          order: ["a"],
          ttlMs: 10,
        },
        queue: [queueItem("a", "pending")],
      }),
    },
    payload("b"),
    receive("b", 20),
    payload("a"),
    receive("a", 21),
  ]);
  add("restored-capacity-null", [
    {
      op: "restore",
      encoded: JSON.stringify({
        seen: { entries: {}, order: [], capacity: null },
        queue: [],
      }),
    },
    payload("a"),
    receive("a", 0),
    receive("a", 1),
  ]);
  add("empty-key", [
    payload("p", ""),
    result(),
    receive("p", 0),
    complete("", 1),
    receive("p", 2),
  ]);
  add(
    "expired-injected-prototype",
    [
      result(),
      complete("__proto__", 0),
      payload("p", "__proto__"),
      receive("p", 1),
      receive("p", { $number: "Infinity" }),
      { op: "roundTrip" },
      receive("p", 2),
    ],
    { ttlMs: 1 },
  );
  const clocks: Stamp[] = [
    0,
    { $number: "-0" },
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
    null,
  ];
  for (const clock of clocks) {
    const suffix = JSON.stringify(clock);
    add(
      `clock-${suffix}`,
      [
        ...normal,
        receive("a", clock),
        { op: "claim", at: clock },
        complete("a", clock),
        receive("a", 0),
        { op: "roundTrip" },
        receive("a", 9),
        receive("a", 10),
      ],
      { ttlMs: 10 },
    );
  }
  const ttls: z.infer<typeof num>[] = [
    -1,
    0,
    { $number: "NaN" },
    { $number: "Infinity" },
    { $number: "-Infinity" },
  ];
  for (const ttlMs of ttls)
    add(
      `ttl-${JSON.stringify(ttlMs)}`,
      [
        ...normal,
        receive("a", 0),
        complete("a", 1),
        receive("a", 0),
        receive("a", 1),
        receive("a", 2),
        { op: "roundTrip" },
        receive("a", 99),
      ],
      { ttlMs },
    );
  const families: ("process" | "replay")[] = ["process", "replay"];
  for (const family of families)
    for (const output of [{ $undefined: true }, null, {}, "wrong"])
      add(`command-${family}-${JSON.stringify(output)}`, [
        ...normal,
        {
          op: "build",
          family,
          key: "a",
          slot: family === "process" ? "a" : "r",
          id: "q",
        },
        { op: "settle", output, at: 1 },
      ]);
  let seed = 0x51a7e;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let run = 0; run < 30; run++) {
    const actions: z.input<typeof action>[] = [
      payload("a"),
      payload("b"),
      payload("c"),
      result(),
    ];
    let clock = 0;
    for (let step = 0; step < 35; step++) {
      const key = ["a", "b", "c"][random() % 3];
      clock += random() % 8;
      switch (random() % 8) {
        case 0:
        case 1:
        case 2:
          actions.push(receive(key, clock, `q${random() % 5}`));
          break;
        case 3:
          actions.push(complete(key, clock));
          break;
        case 4:
          actions.push({ op: "claim", at: clock });
          break;
        case 5:
          actions.push({ op: "boot" });
          break;
        case 6:
          actions.push({ op: "roundTrip" });
          break;
        case 7:
          actions.push({ op: "markDone", id: `q${random() % 5}` });
          break;
      }
    }
    add(`generated-${run}`, actions, { ttlMs: 10 });
  }
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
  return cases;
}
export async function intakeParity(
  options: {
    binary?: string;
    reportFile?: string;
    caseIds?: readonly string[];
  } = {},
) {
  assert.equal(process.version, "v22.21.1");
  assert.equal(process.versions.v8, "12.4.254.21-node.33");
  const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");
  const binary =
    options.binary ??
    join(
      process.env.CARGO_TARGET_DIR ?? join(root, "target"),
      "debug/intake_driver",
    );
  if (!options.binary) {
    const build = spawnSync(
      process.env.CARGO ?? "cargo",
      ["build", "--locked", "-p", "demlik-parity", "--bin", "intake_driver"],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          CARGO_PROFILE_DEV_DEBUG: "0",
          CARGO_PROFILE_TEST_DEBUG: "0",
          CARGO_INCREMENTAL: "0",
          CARGO_BUILD_JOBS: "1",
        },
      },
    );
    assert.equal(build.status, 0);
  }
  const cases = intakeCases().filter(
    (c) => !options.caseIds || options.caseIds.includes(c.id),
  );
  if (options.caseIds) assert.equal(cases.length, options.caseIds.length);
  assert(cases.length > 0);
  const run = spawnSync(binary, [], {
    cwd: root,
    input: `${cases.map((c) => JSON.stringify(c)).join("\n")}\n`,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const native = run.stdout
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({
          id: z.string(),
          output: z.object({ value: z.unknown(), calls: z.array(z.string()) }),
        })
        .parse(JSON.parse(line)),
    );
  assert.equal(native.length, cases.length);
  const results = cases.map((c, i) => {
    assert.equal(native[i].id, c.id);
    const reference = executeIntake(c.input);
    let equal = true;
    try {
      assert.deepEqual(native[i].output.value, reference);
    } catch {
      equal = false;
    }
    return {
      id: c.id,
      actions: c.input.actions.length,
      equal,
      reference,
      rust: native[i].output.value,
      publicCalls: native[i].output.calls,
    };
  });
  const failures = results.filter((r) => !r.equal);
  const rows = (id: string, side: "reference" | "rust") =>
    z.array(z.unknown()).parse(results.find((r) => r.id === id)?.[side]);
  if (!options.caseIds)
    for (const side of ["reference", "rust"] satisfies (
      | "reference"
      | "rust"
    )[]) {
      const final = (id: string) => rows(id, side).at(-1);
      assert.equal(
        z
          .object({ values: z.object({ queue: z.array(z.unknown()) }) })
          .parse(final("intake.pending-never-expires")).values.queue.length,
        1,
      );
      assert.deepEqual(
        z
          .object({ effect: z.object({ commands: z.array(z.unknown()) }) })
          .parse(final("intake.pending-never-expires")).effect.commands,
        [],
      );
      assert.equal(
        z
          .object({
            effect: z.object({
              commands: z.array(z.object({ type: z.string() })),
            }),
          })
          .parse(final("intake.ttl-starts-at-complete")).effect.commands[0]
          .type,
        "intake:process",
      );
      assert.equal(
        z
          .object({
            effect: z.object({
              claimed: z.object({ input: z.object({ key: z.string() }) }),
            }),
          })
          .parse(rows("intake.duplicate-id-claim-first-patch", side)[7]).effect
          .claimed.input.key,
        "a",
      );
      assert.deepEqual(
        z
          .object({
            effect: z.object({
              commands: z.array(
                z.object({ result: z.object({ receipt: z.number() }) }),
              ),
              identities: z.array(z.array(z.string())),
            }),
          })
          .parse(final("intake.result-identity-and-json-detachment")).effect,
        {
          commands: [
            { type: "intake:replay", key: "a", result: { receipt: 99 } },
          ].map((c) => ({ result: c.result })),
          identities: [[]],
        },
      );
      const undefinedRows = rows("intake.undefined-input-presence", side);
      const before = z
        .object({
          values: z.object({
            queue: z.array(z.record(z.string(), z.unknown())),
          }),
        })
        .parse(undefinedRows[2]).values.queue[0];
      const after = z
        .object({
          values: z.object({
            queue: z.array(z.record(z.string(), z.unknown())),
          }),
        })
        .parse(undefinedRows[4]).values.queue[0];
      assert.equal(Object.hasOwn(before, "input"), true);
      assert.equal(Object.hasOwn(after, "input"), false);
    }
  const files = [
    "packages/tea/src/internal/idempotency/idempotent-intake/index.ts",
    "packages/tea/src/internal/idempotency/idempotency/index.ts",
    "packages/tea/src/internal/work-queue/ops.ts",
    "crates/tea/src/idempotency.rs",
    "crates/tea/src/idempotency/adapter.rs",
    "crates/tea/src/idempotency/intake.rs",
    "crates/tea/src/idempotency/intake/wire.rs",
    "crates/tea/src/js_record.rs",
    "crates/tea/src/work_queue/mod.rs",
    "crates/tea/src/work_queue/ops.rs",
    "crates/parity/src/bin/intake_driver.rs",
    "verification/parity/idempotent-intake.mts",
  ];
  const hash = (p: string) =>
    createHash("sha256").update(readFileSync(p)).digest("hex");
  const mappings = [
    ["createIntake", "Intake::new"],
    ["init", "Intake::init"],
    ["receive", "Intake::receive"],
    ["complete", "Intake::complete"],
    ["boot", "Intake::boot"],
    ["claimNext", "Intake::claim_next"],
    ["intakeProcessDef", "intake::intake_process_def::<HostValue>"],
    ["intakeReplayDef", "intake::intake_replay_def::<HostValue>"],
  ].map(([sourceSymbol, nativeSymbol]) => ({
    sourceSymbol,
    sourcePath: files[0],
    nativeSymbol,
    nativePath: "crates/tea/src/idempotency/intake.rs",
    caseIds: results
      .filter((r) => r.equal && r.publicCalls.includes(nativeSymbol))
      .map((r) => r.id),
  }));
  if (!options.caseIds && failures.length === 0)
    assert(mappings.every((m) => m.caseIds.length > 0));
  const report = {
    version: 1,
    passed: results.length - failures.length,
    total: results.length,
    actions: results.reduce((n, r) => n + r.actions, 0),
    failures,
    results,
    openGaps: [],
    sourceHashes: Object.fromEntries(
      files.map((f) => [f, hash(join(root, f))]),
    ),
    binaryHash: hash(binary),
    engine: { node: process.version, v8: process.versions.v8 },
    capabilityMappingProposal: mappings,
    qualifications: [
      "Optional idempotency policy fields compare JSON bytes/read semantics; initial own-undefined versus JSON-restored absent policy fields are not reflection-equivalent in the existing native owner.",
      "Numeric authored clocks and their JSON-restored null are covered; manually missing or nonnumeric clocks are not typed clock parity.",
      "Record/prototype behavior uses the bounded pristine Object.prototype compatibility profile. Arbitrary getters/global prototype mutation/cyclic JS heaps are outside this adapter.",
      "Opaque payloads/results have no pure Clone/serde/Send requirement. Actual wire conversion and raw projected result decoding are explicit boundary codecs.",
    ],
  };
  const reportFile =
    options.reportFile ?? join(root, "target/parity/idempotent-intake.json");
  mkdirSync(dirname(reportFile), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { binary: { type: "string" }, report: { type: "string" } },
  });
  const r = await intakeParity({
    binary: values.binary,
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      passed: r.passed,
      total: r.total,
      actions: r.actions,
      failures: r.failures.map((f) => f.id),
      report: values.report ?? "target/parity/idempotent-intake.json",
    }),
  );
  if (r.failures.length) process.exitCode = 1;
}
