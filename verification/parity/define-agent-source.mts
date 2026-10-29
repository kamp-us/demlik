import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  AGENT_EVENT_TYPES,
  type AgentMessage,
  type AgentTurn,
  agentEvents,
  type ContentPart,
  type DefinedAgentState,
  defineAgent,
  status,
  type ToolCall,
  tool,
  toolRouter,
} from "../../packages/tea/src/agent/index.ts";
import { memoryStore } from "../../packages/tea/src/mem/index.ts";
import { driveToDone, run } from "../../packages/tea/src/promise/index.ts";
import type { Store } from "../../packages/tea/src/runtime-types.ts";

type Scenario =
  | "invoice.run-complete"
  | "invoice.machine-complete"
  | "invoice.resume-awaiting-brain"
  | "invoice.resume-awaiting-tool"
  | "invoice.terminal-no-work"
  | "invoice.declared-tool-failure-recovery";
function isScenario(value: string | undefined): value is Scenario {
  return [
    "invoice.run-complete",
    "invoice.machine-complete",
    "invoice.resume-awaiting-brain",
    "invoice.resume-awaiting-tool",
    "invoice.terminal-no-work",
    "invoice.declared-tool-failure-recovery",
  ].some((id) => id === value);
}
const scenario = process.argv[2];
assert(isScenario(scenario), "an exact named Source scenario is required");
const directory = process.argv[3];
assert(directory, "owned invoice directory is required");
await mkdir(directory, { recursive: true });
const INSTRUCTIONS = "Collect invoice 17, check its total, write its summary.";
const INPUT = "Finish invoice 17 from invoice.json.";
const RUN_ID = "invoice-run-17";
const AT = 50;
const INVOICE = { id: "invoice-17", lines: [7, 10], total: 17 };
await writeFile(
  path.join(directory, "invoice.json"),
  `${JSON.stringify(INVOICE)}\n`,
);

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Collected = { readonly invoiceId: string; readonly raw: string };
type Host = {
  readonly services: { readonly directory: string; readonly marker: object };
  readonly token: object;
};
function isCollectArgs(value: unknown): value is { readonly file: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "file" in value &&
    typeof value.file === "string"
  );
}
function isCollected(value: unknown): value is Collected {
  return (
    typeof value === "object" &&
    value !== null &&
    "invoiceId" in value &&
    typeof value.invoiceId === "string" &&
    "raw" in value &&
    typeof value.raw === "string"
  );
}
const invoiceSchema = z.object({
  id: z.string(),
  lines: z.array(z.number()),
  total: z.number(),
});

function makeTurns(failing: boolean) {
  const provider = { resumeToken: { original: "provider-17" }, extra: [1, 2] };
  const collect = {
    callId: "collect-17",
    name: "collect_invoice",
    args: { file: "invoice.json", rawExtra: { keep: true } },
  };
  const check = {
    callId: "check-17",
    name: "check_invoice",
    args: {
      file: "invoice.json",
      expected: failing ? 18 : 17,
      rawExtra: { keep: true },
    },
  };
  const summarize = {
    callId: "summary-17",
    name: "summarize_invoice",
    args: {
      file: "invoice.json",
      destination: "report.txt",
      rawExtra: { keep: true },
    },
  };
  const turns = [
    {
      content: "Collect invoice",
      toolCalls: [collect],
      provider,
      unknownTurn: { keep: true },
    },
    {
      content: "Check invoice",
      toolCalls: [check],
      provider,
      unknownTurn: { keep: true },
    },
    ...(failing
      ? []
      : [
          {
            content: "Summarize invoice",
            toolCalls: [summarize],
            provider,
            unknownTurn: { keep: true },
          },
        ]),
    {
      content: failing
        ? "Invoice total rejected"
        : "Invoice 17 checked and summarized",
      toolCalls: [],
      provider,
      unknownTurn: { keep: true },
    },
  ];
  const typed: readonly AgentTurn[] = turns;
  return { turns: typed, collect, check, summarize };
}
function makeTools(
  directory: string,
  script: ReturnType<typeof makeTurns>,
  holdTool?: ReturnType<typeof deferred<void>>,
  retainedCalls: readonly ToolCall[] = [],
) {
  const host: Host = {
    services: { directory, marker: { label: "invoice-host" } },
    token: { owner: "host-token" },
  };
  const calls: {
    tool: string;
    args: unknown;
    rawSame: boolean;
    hostObjectSame: boolean;
    servicesSame: boolean;
    tokenSame: boolean;
  }[] = [];
  const validators: { tool: string; originalRaw: boolean }[] = [];
  const returned: { tool: string; value: unknown }[] = [];
  const content: {
    tool: string;
    result: unknown;
    returnedSame: boolean;
    parts: readonly ContentPart[];
  }[] = [];
  const errorData = {
    invoice: "invoice-17",
    evidence: { source: "validator", code: 17 },
  };
  const toolEntered = deferred<void>();
  const rawCollect =
    retainedCalls.find((call) => call.callId === "collect-17")?.args ??
    script.collect.args;
  const rawCheck =
    retainedCalls.find((call) => call.callId === "check-17")?.args ??
    script.check.args;
  const rawSummary =
    retainedCalls.find((call) => call.callId === "summary-17")?.args ??
    script.summarize.args;
  const observe = (name: string, args: unknown, ctx: Host, raw: unknown) => {
    calls.push({
      tool: name,
      args,
      rawSame: args === raw,
      hostObjectSame: ctx === host,
      servicesSame: ctx.services === host.services,
      tokenSame: ctx.token === host.token,
    });
  };
  const collect = tool(
    "collect_invoice",
    {
      description: "Read the original invoice file.",
      input: z.custom<{ readonly file: string }>((raw) => {
        validators.push({
          tool: "collect_invoice",
          originalRaw: raw === rawCollect,
        });
        return isCollectArgs(raw);
      }),
      ok: z.custom<Collected>(isCollected),
      err: [],
      content: (result) => {
        const parts: readonly ContentPart[] = [
          { type: "text", text: result.raw },
        ];
        content.push({
          tool: "collect_invoice",
          result,
          returnedSame: returned.some(
            (entry) =>
              entry.tool === "collect_invoice" && entry.value === result,
          ),
          parts,
        });
        return parts;
      },
    },
    async (args, ctx: Host, { ok }) => {
      observe("collect_invoice", args, ctx, rawCollect);
      const raw = await readFile(
        path.join(ctx.services.directory, args.file),
        "utf8",
      );
      toolEntered.resolve();
      if (holdTool !== undefined) await holdTool.promise;
      const value = { invoiceId: "invoice-17", raw };
      returned.push({ tool: "collect_invoice", value });
      return ok(value);
    },
  );
  const check = tool(
    "check_invoice",
    {
      description: "Validate and reconcile the real invoice total.",
      input: z.preprocess(
        (raw) => {
          validators.push({
            tool: "check_invoice",
            originalRaw: raw === rawCheck,
          });
          return raw;
        },
        z.object({ file: z.string(), expected: z.number() }),
      ),
      ok: z.object({
        invoiceId: z.string(),
        valid: z.boolean(),
        total: z.number(),
      }),
      err: ["invalid_invoice"],
    },
    async (args, ctx: Host, { ok, fail }) => {
      observe("check_invoice", args, ctx, rawCheck);
      const value = invoiceSchema.parse(
        JSON.parse(
          await readFile(path.join(ctx.services.directory, args.file), "utf8"),
        ),
      );
      const total = value.lines.reduce((sum, line) => sum + line, 0);
      if (total !== args.expected || total !== value.total)
        return fail({
          _tag: "invalid_invoice",
          expected: args.expected,
          actual: total,
          data: errorData,
        });
      const result = { invoiceId: value.id, valid: true, total };
      returned.push({ tool: "check_invoice", value: result });
      return ok(result);
    },
  );
  const summarize = tool(
    "summarize_invoice",
    {
      description: "Write the checked invoice summary to a real file.",
      input: z.object({ file: z.string(), destination: z.string() }),
      ok: z.object({ file: z.string(), text: z.string() }),
      err: [],
      content: (result) => {
        const parts: readonly ContentPart[] = [
          { type: "text", text: result.text },
        ];
        content.push({
          tool: "summarize_invoice",
          result,
          returnedSame: returned.some(
            (entry) =>
              entry.tool === "summarize_invoice" && entry.value === result,
          ),
          parts,
        });
        return parts;
      },
    },
    async (args, ctx: Host, { ok }) => {
      observe("summarize_invoice", args, ctx, rawSummary);
      const value = invoiceSchema.parse(
        JSON.parse(
          await readFile(path.join(ctx.services.directory, args.file), "utf8"),
        ),
      );
      const text = `${value.id}: ${value.total}\n`;
      await writeFile(
        path.join(ctx.services.directory, args.destination),
        text,
      );
      const result = { file: args.destination, text };
      returned.push({ tool: "summarize_invoice", value: result });
      return ok(result);
    },
  );
  return {
    tools: [collect, check, summarize] as const,
    host,
    calls,
    validators,
    returned,
    content,
    errorData,
    toolEntered,
  };
}
type Tool = ReturnType<typeof makeTools>["tools"][number];
type State = DefinedAgentState<Tool>;

function session(
  options: {
    seed?: State;
    hold?: "brain" | "tool";
    startIndex?: number;
    instructions?: string;
    failing?: boolean;
  } = {},
) {
  const script = makeTurns(options.failing ?? false);
  const release = deferred<void>();
  const entered = deferred<void>();
  const checkpoint = deferred<State>();
  let checkpointTaken = false;
  let index = options.startIndex ?? 0;
  const retainedTurns = options.seed?.conversation?.turns ?? [];
  const tools = makeTools(
    directory,
    script,
    options.hold === "tool" ? release : undefined,
    retainedTurns.flatMap((turn) => turn.toolCalls),
  );
  const expectedTurns = [...retainedTurns, ...script.turns];
  const prompts: {
    messages: readonly AgentMessage[];
    argumentCount: number;
    assistantOriginalCalls: boolean[];
    assistantOriginalProvider: boolean[];
    partsOriginal: boolean[];
  }[] = [];
  const returnedTurns: AgentTurn[] = [];
  const events: unknown[] = [];
  const hooks: unknown[] = [];
  const saves: { wire: string; phase: string; awaiting: string | null }[] = [];
  const loads: { raw: unknown; sameSeed: boolean }[] = [];
  const observations: { message: unknown; stateWire: string }[] = [];
  let current: State | undefined;
  let lastNonNullConversation = options.seed?.conversation ?? null;
  const memory = memoryStore<State>(options.seed);
  const store: Store<State> = {
    ...memory,
    async load() {
      const raw = await memory.load();
      loads.push({ raw, sameSeed: raw === options.seed });
      return raw;
    },
    async save(state) {
      current = state;
      if (state.conversation !== null)
        lastNonNullConversation = state.conversation;
      saves.push({
        wire: JSON.stringify(state),
        phase: state.run.phase,
        awaiting: state.conversation?.awaiting.kind ?? null,
      });
      await memory.save(state);
      const conversation = state.conversation;
      if (
        !checkpointTaken &&
        conversation !== null &&
        ((options.hold === "brain" &&
          conversation.awaiting.kind === "llm" &&
          conversation.toolRecords.length === 1) ||
          (options.hold === "tool" &&
            conversation.awaiting.kind === "tools" &&
            conversation.turns.length === 1))
      ) {
        checkpointTaken = true;
        checkpoint.resolve(state);
      }
    },
  };
  const model = async function model(
    messages: readonly AgentMessage[],
    ...extra: readonly unknown[]
  ) {
    const assistants = messages.filter(
      (message) => message.role === "assistant",
    );
    prompts.push({
      messages,
      argumentCount: 1 + extra.length,
      assistantOriginalCalls: assistants.map((message) =>
        expectedTurns.some((turn) => turn.toolCalls === message.toolCalls),
      ),
      assistantOriginalProvider: assistants.map((message) =>
        expectedTurns.some((turn) => turn.provider === message.provider),
      ),
      partsOriginal: messages.flatMap((message) =>
        message.role === "tool" && message.parts !== undefined
          ? [tools.content.some((entry) => entry.parts === message.parts)]
          : [],
      ),
    });
    const next = script.turns[index];
    assert(
      next,
      "the model must not be invoked beyond the scripted invoice job",
    );
    index += 1;
    if (options.hold === "brain" && index === 2) {
      entered.resolve();
      await release.promise;
    }
    returnedTurns.push(next);
    return next;
  };
  const lid = defineAgent({
    model,
    tools: tools.tools,
    instructions: options.instructions ?? INSTRUCTIONS,
    onToolError: async (outcome, context) => {
      hooks.push({
        outcome,
        context,
        recordsBeforeHook: current?.conversation?.toolRecords.length ?? null,
        originalErrorData:
          outcome._tag === "invalid_invoice" &&
          outcome.data === tools.errorData,
      });
    },
  });
  const runOptions = {
    ctx: tools.host,
    store,
    runId: RUN_ID,
    clock: () => AT,
    onEvent: (event: unknown) => events.push(event),
  };
  async function execute(machine = false): Promise<State> {
    if (!machine) return lid.run(INPUT, runOptions);
    const wired = lid.machine(INPUT);
    const handle = run(wired.machine, {
      ...runOptions,
      interpret: wired.interpret,
      subscribe: wired.subscribe,
      terminal: (state) =>
        state.run.phase === "done" || state.run.phase === "cancelled",
      events: agentEvents({ tools: toolRouter(tools.tools) }),
    });
    for (const type of AGENT_EVENT_TYPES)
      handle.on(type, (event) => events.push(event));
    const runtime = await handle.ready;
    const detach = runtime.observe((message, state) =>
      observations.push({ message, stateWire: JSON.stringify(state) }),
    );
    try {
      return await driveToDone(
        handle,
        { type: "agent_start", runId: RUN_ID, at: AT },
        (state) =>
          state.run.phase === "done" || state.run.phase === "cancelled",
        { failed: (state) => status(state).kind === "failed" },
      );
    } finally {
      detach();
    }
  }
  function receipt(final: State) {
    return {
      prompts,
      events,
      hooks,
      saves,
      loads,
      observations,
      handlerCalls: tools.calls,
      parserInputs: tools.validators,
      returnedResults: tools.returned,
      contentCallbacks: tools.content,
      returnedTurns,
      lastNonNullConversation,
      final,
      finalWire: JSON.stringify(final),
      terminal: status(final),
      storeSaveScope:
        "all actual saves; public run does not expose a transition-versus-stop label",
    };
  }
  return {
    execute,
    receipt,
    release,
    entered: options.hold === "tool" ? tools.toolEntered : entered,
    checkpoint,
    tools,
    script,
    returnedTurns,
  };
}

const sessions: ReturnType<typeof session>[] = [];
const receipts: ReturnType<ReturnType<typeof session>["receipt"]>[] = [];
let final: State;
let checkpointWire: string | null = null;
let resumedSameObject: boolean | null = null;
if (
  scenario === "invoice.resume-awaiting-brain" ||
  scenario === "invoice.resume-awaiting-tool"
) {
  const hold = scenario === "invoice.resume-awaiting-brain" ? "brain" : "tool";
  const first = session({ hold });
  sessions.push(first);
  const running = first.execute();
  const checkpoint = await first.checkpoint.promise;
  await first.entered.promise;
  checkpointWire = JSON.stringify(checkpoint);
  first.release.resolve();
  receipts.push(first.receipt(await running));
  const second = session({
    seed: checkpoint,
    startIndex: 1,
    instructions: "New config instructions must not replace the stored ones.",
  });
  sessions.push(second);
  final = await second.execute();
  receipts.push(second.receipt(final));
} else if (scenario === "invoice.terminal-no-work") {
  const first = session();
  sessions.push(first);
  const ended = await first.execute();
  receipts.push(first.receipt(ended));
  const second = session({ seed: ended, startIndex: 100 });
  sessions.push(second);
  final = await second.execute();
  receipts.push(second.receipt(final));
  resumedSameObject = final === ended;
} else {
  const current = session({
    failing: scenario === "invoice.declared-tool-failure-recovery",
  });
  sessions.push(current);
  final = await current.execute(scenario === "invoice.machine-complete");
  receipts.push(current.receipt(final));
}
const rawObservation = {
  id: scenario,
  profile: "published-Promise",
  fixedClock: AT,
  runId: RUN_ID,
  input: INPUT,
  instructions: INSTRUCTIONS,
  invoice: INVOICE,
  receipts,
  checkpointWire,
  resumeProfile:
    checkpointWire === null
      ? null
      : "retained in-process canonical State; JSON bytes recorded, not decoded",
  resumedSameObject,
};
await writeFile(
  path.join(directory, "observed-before-assert.json"),
  `${JSON.stringify(rawObservation)}\n`,
);
if (
  scenario === "invoice.resume-awaiting-brain" ||
  scenario === "invoice.resume-awaiting-tool"
) {
  assert.equal(
    receipts[1].handlerCalls.filter((call) => call.tool === "collect_invoice")
      .length,
    scenario === "invoice.resume-awaiting-brain" ? 0 : 1,
  );
  assert.equal(receipts[1].prompts.length, 3);
}
if (scenario === "invoice.terminal-no-work") {
  assert.equal(resumedSameObject, true);
  assert.equal(receipts[1].prompts.length, 0);
  assert.equal(receipts[1].handlerCalls.length, 0);
  assert.equal(receipts[1].events.length, 0);
}
assert.equal(final.run.phase, "done");
assert.equal(final.run.runId, RUN_ID);
assert.equal(final.instructions, INSTRUCTIONS);
const failedTool = scenario === "invoice.declared-tool-failure-recovery";
assert.equal(
  final.output?.content,
  failedTool ? "Invoice total rejected" : "Invoice 17 checked and summarized",
);
assert.equal(final.conversation, null);
let lastNonNullConversation: State["conversation"] = null;
for (const receipt of receipts)
  if (receipt.lastNonNullConversation !== null)
    lastNonNullConversation = receipt.lastNonNullConversation;
assert(lastNonNullConversation);
assert.equal(lastNonNullConversation.toolRecords.length, failedTool ? 2 : 3);
const returnedTurns = sessions.flatMap((current) => current.returnedTurns);
const originalTurns = lastNonNullConversation.turns.map((turn) =>
  returnedTurns.includes(turn),
);
assert(
  originalTurns.length > 0 && originalTurns.every(Boolean),
  "guarded turns must remain the actual model-returned owners",
);
const originalCalls = lastNonNullConversation.toolRecords.map((record) =>
  returnedTurns.some((turn) =>
    turn.toolCalls.some(
      (call) => call === record.call && call.args === record.call.args,
    ),
  ),
);
assert(
  originalCalls.length > 0 && originalCalls.every(Boolean),
  "records must retain original model call and raw args owners",
);
for (const receipt of receipts) {
  assert(
    receipt.handlerCalls.every((call) => call.servicesSame && call.tokenSame),
  );
  assert(receipt.prompts.every((prompt) => prompt.argumentCount === 1));
  assert(
    receipt.prompts.every((prompt) => prompt.partsOriginal.every(Boolean)),
  );
  assert(receipt.parserInputs.every((input) => input.originalRaw));
}
const relevant = receipts.filter((receipt) => receipt.handlerCalls.length > 0);
assert(
  relevant.every(
    (receipt) =>
      receipt.handlerCalls.find((call) => call.tool === "check_invoice")
        ?.rawSame === false,
  ),
);
assert(
  receipts[0].handlerCalls.find((call) => call.tool === "collect_invoice")
    ?.rawSame === true,
);
const report = failedTool
  ? null
  : await readFile(path.join(directory, "report.txt"), "utf8");
if (!failedTool) assert.equal(report, "invoice-17: 17\n");
if (failedTool) {
  assert.equal(receipts[0].hooks.length, 1);
  assert.equal(lastNonNullConversation.toolRecords[1]?.outcome.kind, "error");
  assert.equal(receipts[0].handlerCalls.length, 2);
}
process.stdout.write(
  `${JSON.stringify({ ...rawObservation, originalTurns, originalCalls, report, assertionsPassed: true })}\n`,
);
