import { type Cmd, defineMachine, type Interpret } from "@demlik/tea";
import { run } from "@demlik/tea/promise";
import {
  type AgentMachineMsg,
  type AgentTurn,
  createAgent,
  type Schema,
  type ToolCall,
} from "@demlik/tea/agent";
import { toMermaid } from "@demlik/tea/machine-viz";
import { createIntake, type IntakeCmd } from "@demlik/tea/idempotency";
import {
  createPaginatedWalk,
  type PageErrMsg,
  type PageOkMsg,
  type PaginatedWalkState,
  type PaginatedWalkTimerMsg,
} from "@demlik/tea/paginate";
import { recorder, replayTrace } from "@demlik/tea/persistence";
import {
  createResilientCall,
  type FailMsg,
  type ResilientState,
  type ResilientTimerMsg,
  type RunCmd,
  type SucceedMsg,
} from "@demlik/tea/resilience";

type Stage = "plan" | "crawl" | "audit" | "report";
type Purpose = Stage;

type Outputs = {
  plan: AgentTurn;
  crawl: AgentTurn;
  audit: AgentTurn;
  report: AgentTurn;
};

interface AuditFinding {
  readonly url: string;
  readonly violations: number;
  readonly note: string;
}

type ToolResult =
  | { readonly kind: "sitemap"; readonly urls: readonly string[] }
  | {
      readonly kind: "audit";
      readonly finding: AuditFinding;
      readonly disposition: "process" | "replay";
    };

type RunCrawl = Cmd<"run_crawl"> & ToolCall;
type RunAudit = Cmd<"run_audit"> & ToolCall;
type ToolCmd = RunCrawl | RunAudit;

type ChatMsg = { readonly role: "system" | "user"; readonly content: string };

type SitemapPage = {
  readonly urls: readonly string[];
  readonly next: string | null;
};

const SITEMAP_PAGES: Record<string, SitemapPage> = {
  p1: { urls: ["/", "/pricing"], next: "p2" },
  p2: { urls: ["/docs", "/blog"], next: null },
};

const AUDIT_TABLE: Record<string, AuditFinding> = {
  "/": { url: "/", violations: 0, note: "clean landing" },
  "/pricing": { url: "/pricing", violations: 3, note: "low-contrast CTA" },
  "/docs": { url: "/docs", violations: 1, note: "missing skip-link" },
  "/blog": { url: "/blog", violations: 2, note: "unlabeled images" },
};

const auditCallId = (url: string): string => `audit:${url}`;
const reauditCallId = (url: string): string => `reaudit:${url}`;
const urlOfAuditCall = (callId: string): string =>
  callId.slice(callId.indexOf(":") + 1);

const planTurn: AgentTurn = {
  content: "Plan the run: crawl the sitemap, then audit every discovered page.",
  toolCalls: [],
};

const crawlTurn: AgentTurn = {
  content: "Crawl the sitemap page by page to discover URLs.",
  toolCalls: [{ callId: "crawl:sitemap", name: "crawl_sitemap", args: {} }],
};

const crawlDoneTurn: AgentTurn = {
  content: "Sitemap discovered. Moving to per-page audits.",
  toolCalls: [],
};

const auditFanTurn: AgentTurn = {
  content: "Fan out an accessibility audit across every discovered page.",
  toolCalls: [
    {
      callId: auditCallId("/"),
      name: "audit_page",
      args: { url: "/" },
    },
    {
      callId: auditCallId("/pricing"),
      name: "audit_page",
      args: { url: "/pricing" },
    },
    {
      callId: auditCallId("/docs"),
      name: "audit_page",
      args: { url: "/docs" },
    },
    {
      callId: reauditCallId("/docs"),
      name: "audit_page",
      args: { url: "/docs" },
    },
    {
      callId: auditCallId("/blog"),
      name: "audit_page",
      args: { url: "/blog" },
    },
  ],
};

const auditDoneTurn: AgentTurn = {
  content: "All page audits folded. Findings gathered.",
  toolCalls: [],
};

const reportTurn: AgentTurn = {
  content:
    "Report: audited 4 pages, 6 total violations. Worst: /pricing (3). Ship fixes top-down.",
  toolCalls: [],
};

const SCRIPT: Record<Purpose, readonly AgentTurn[]> = {
  plan: [planTurn],
  crawl: [crawlTurn, crawlDoneTurn],
  audit: [auditFanTurn, auditDoneTurn],
  report: [reportTurn],
};

const attempts: Record<Purpose, number> = {
  plan: 0,
  crawl: 0,
  audit: 0,
  report: 0,
};

function isAgentTurn(value: unknown): value is AgentTurn {
  if (value === null || typeof value !== "object") return false;
  const turn = value as { content?: unknown; toolCalls?: unknown };
  if (typeof turn.content !== "string") return false;
  if (!Array.isArray(turn.toolCalls)) return false;
  return turn.toolCalls.every((call) => {
    if (call === null || typeof call !== "object") return false;
    const c = call as { callId?: unknown; name?: unknown; args?: unknown };
    return (
      typeof c.callId === "string" &&
      typeof c.name === "string" &&
      c.args !== null &&
      typeof c.args === "object"
    );
  });
}

function purposeSchema(
  purpose: Purpose,
): Schema<AgentTurn> & { readonly purpose: Purpose } {
  return {
    purpose,
    parse: (value: unknown): AgentTurn => {
      if (!isAgentTurn(value)) {
        throw new Error(
          `structured-output parse failed for "${purpose}": not an AgentTurn`,
        );
      }
      return value;
    },
  };
}

const schemas = {
  plan: purposeSchema("plan"),
  crawl: purposeSchema("crawl"),
  audit: purposeSchema("audit"),
  report: purposeSchema("report"),
};

function fakeModel() {
  return {
    withStructuredOutput<T>(schema: Schema<T> & { purpose?: Purpose }) {
      const purpose = (schema.purpose ?? "report") as Purpose;
      return {
        invoke: async (_messages: readonly ChatMsg[]): Promise<T> => {
          const turns = SCRIPT[purpose];
          const i = Math.min(attempts[purpose], turns.length - 1);
          attempts[purpose] += 1;
          const turn = turns[i] ?? { content: "", toolCalls: [] };
          return schema.parse(turn);
        },
      };
    },
  };
}

type WalkCursor = string;
type WalkState = { readonly walk: PaginatedWalkState<WalkCursor, SitemapPage> };
type WalkMsg =
  | { readonly type: "walk_start"; readonly at: number }
  | PageOkMsg<SitemapPage>
  | PageErrMsg
  | PaginatedWalkTimerMsg;
type WalkCmd = RunCmd<WalkCursor>;
type WalkCtx = {
  readonly fetchPage: (cursor: WalkCursor) => Promise<SitemapPage>;
};

const crawler = createPaginatedWalk<WalkCursor, SitemapPage, never>(
  {
    firstPage: "p1",
    nextCursor: (page) => page.next,
    onPage: () => [],
    retry: { baseMs: 1, factor: 2, capMs: 4, maxAttempts: 5, jitter: "none" },
    rateLimit: { capacity: 8, refillPerSec: 64 },
  },
  () => 0,
);

const walkMachine = defineMachine({
  types: {
    model: {} as WalkState,
    msg: {} as WalkMsg,
    cmd: {} as WalkCmd,
    ctx: {} as WalkCtx,
  },
  // The page fetch is `Cmd.define`d: the engine mints its settle Msgs.
  cmds: [crawler.fetch],
  init: (loaded) =>
    loaded !== null ? [loaded, []] : [{ walk: crawler.init() }, []],
  update: {
    walk_start: (s, m) => {
      const [walk, cmds] = crawler.start(s.walk, m.at);
      return [{ walk }, cmds];
    },
    resilient_run_ok: (s, m) => {
      const [walk, cmds] = crawler.pageOk(s.walk, m);
      return [{ walk }, cmds];
    },
    resilient_run_err: (s, m) => {
      const [walk, cmds] = crawler.pageErr(s.walk, m);
      return [{ walk }, cmds];
    },
    deadline_exceeded: (s, m) => {
      const [walk, cmds] = crawler.onTimer(s.walk, m);
      return [{ walk }, cmds];
    },
  },
  // The retry timer. `timer` is built into the engine.
  subs: [{ type: "timer", deps: (s: WalkState) => crawler.timer(s.walk) }],
});

// The machine is data; its handler rides beside it into `run`. It returns an
// outcome, and the engine turns it into the settle Msg.
const walkInterpret: Interpret<WalkMsg, WalkCmd, WalkCtx> = {
  resilient_run: async (cmd, ctx) => {
    try {
      return ctx.ok(await ctx.fetchPage(cmd.input));
    } catch (cause) {
      return ctx.err({ _tag: "port_rejected", cause: String(cause) });
    }
  },
};

let walkFetches = 0;
let walkRetries = 0;
let walkPageFlakyArmed = true;

async function runCrawlSubRun(): Promise<readonly string[]> {
  const fetchPage = async (cursor: WalkCursor): Promise<SitemapPage> => {
    walkFetches += 1;
    if (cursor === "p2" && walkPageFlakyArmed) {
      walkPageFlakyArmed = false;
      walkRetries += 1;
      throw new Error("429 from sitemap host (transient) on p2");
    }
    const page = SITEMAP_PAGES[cursor];
    if (page === undefined) throw new Error(`no sitemap page ${cursor}`);
    return page;
  };
  const runtime = await run(walkMachine, {
    ctx: { fetchPage },
    interpret: walkInterpret,
  }).ready;
  const discovered: string[] = [];
  runtime.observe((msg) => {
    if (msg !== null && msg.type === "resilient_run_ok") {
      for (const url of msg.value.urls) discovered.push(url);
    }
  });
  await runtime.dispatch({ type: "walk_start", at: 1 });
  await until(
    () => crawler.isComplete(runtime.getState().walk),
    "paginated-walk reaches done",
  );
  await runtime.stop();
  return discovered;
}

type AuditCallState = {
  readonly resilience: ResilientState<string, AuditFinding>;
};
type AuditCallMsg =
  | { readonly type: "audit_start"; readonly url: string; readonly at: number }
  | SucceedMsg<AuditFinding>
  | FailMsg
  | ResilientTimerMsg;
type AuditCallCmd = RunCmd<string>;
type AuditCtx = {
  readonly callAuditEngine: (url: string) => Promise<AuditFinding>;
};

const auditCall = createResilientCall<string, AuditFinding>(
  {
    circuit: { threshold: 5, cooldownMs: 1 },
    retry: { baseMs: 1, factor: 2, capMs: 4, maxAttempts: 5, jitter: "none" },
  },
  () => 0,
);

const AUDIT_KEY = "audit";

const auditMachine = defineMachine({
  types: {
    model: {} as AuditCallState,
    msg: {} as AuditCallMsg,
    cmd: {} as AuditCallCmd,
    ctx: {} as AuditCtx,
  },
  cmds: [auditCall.run],
  init: (loaded) =>
    loaded !== null ? [loaded, []] : [{ resilience: auditCall.init() }, []],
  update: {
    audit_start: (s, m) => {
      const [resilience, cmds] = auditCall.attempt(
        s.resilience,
        AUDIT_KEY,
        m.url,
        m.at,
      );
      return [{ resilience }, cmds];
    },
    resilient_run_ok: (s, m) => {
      const { call, cmds } = auditCall.settle(s.resilience, m);
      return [{ resilience: call }, cmds];
    },
    resilient_run_err: (s, m) => {
      const { call, cmds } = auditCall.settle(s.resilience, m);
      return [{ resilience: call }, cmds];
    },
    deadline_exceeded: (s, m) => {
      const [resilience, cmds] = auditCall.onTimer(s.resilience, m);
      return [{ resilience }, cmds];
    },
  },
  subs: [
    {
      type: "timer",
      deps: (s: AuditCallState) => auditCall.timer(s.resilience),
    },
  ],
});

// The machine is data; its handler rides beside it into `run`.
const auditInterpret: Interpret<AuditCallMsg, AuditCallCmd, AuditCtx> = {
  resilient_run: async (cmd, ctx) => {
    try {
      return ctx.ok(await ctx.callAuditEngine(cmd.input));
    } catch (cause) {
      return ctx.err({ _tag: "port_rejected", cause: String(cause) });
    }
  },
};

let flakyArmed = true;
let flakyHits = 0;
let auditEngineRetries = 0;

async function runAuditSubRun(url: string): Promise<AuditFinding> {
  let auditClock = 0;
  let attemptsForUrl = 0;
  const callAuditEngine = async (target: string): Promise<AuditFinding> => {
    attemptsForUrl += 1;
    if (target === "/pricing" && flakyArmed) {
      flakyArmed = false;
      flakyHits += 1;
      throw new Error("503 from audit-engine (transient) on /pricing");
    }
    if (target === "/pricing") flakyHits += 1;
    return (
      AUDIT_TABLE[target] ?? {
        url: target,
        violations: 0,
        note: "no rule matched",
      }
    );
  };
  const runtime = await run(auditMachine, {
    ctx: { callAuditEngine },
    interpret: auditInterpret,
  }).ready;
  auditClock += 1;
  await runtime.dispatch({ type: "audit_start", url, at: auditClock });
  await until(() => {
    const call = runtime.getState().resilience.calls[AUDIT_KEY];
    return call?.phase === "succeeded" || call?.phase === "failed";
  }, `audit('${url}') settles`);
  const call = runtime.getState().resilience.calls[AUDIT_KEY];
  await runtime.stop();
  if (attemptsForUrl > 1) auditEngineRetries += attemptsForUrl - 1;
  if (call === undefined || call.phase !== "succeeded") {
    throw new Error(`audit('${url}') did not recover`);
  }
  return call.result;
}

const intake = createIntake<string, AuditFinding>({ keyOf: (url) => url });
let intakeState = intake.init();
let auditedFresh = 0;
let auditedSkipped = 0;
const intakeReplays: string[] = [];

async function settleIntake(
  cmds: readonly IntakeCmd<string, AuditFinding>[],
  at: number,
): Promise<{ finding: AuditFinding; disposition: "process" | "replay" }> {
  const cmd = cmds[0];
  if (cmd === undefined) {
    throw new Error("intake.receive emitted no decision Cmd");
  }
  if (cmd.type === "intake:replay") {
    auditedSkipped += 1;
    intakeReplays.push(cmd.key);
    return { finding: cmd.result, disposition: "replay" };
  }
  const finding = await runAuditSubRun(cmd.payload);
  [intakeState] = intake.complete(intakeState, cmd.key, finding, at);
  auditedFresh += 1;
  return { finding, disposition: "process" };
}

const agent = createAgent<
  Stage,
  Purpose,
  Outputs,
  ToolResult,
  ToolCmd,
  ChatMsg
>({
  stages: ["plan", "crawl", "audit", "report"],
  model: fakeModel,
  schemas,
  turnOf: (stage) => stage ?? "report",
  payloadOf: (stage) => ({ stage }),
  toolOf: (call): ToolCmd =>
    call.name === "crawl_sitemap"
      ? { type: "run_crawl", ...call }
      : { type: "run_audit", ...call },
  toolConcurrency: 1,
  retry: { baseMs: 10, factor: 2, capMs: 50, maxAttempts: 5, jitter: "none" },
  deadlineMs: 600_000,
  maxTurns: 50,
  loadMessages: async () => [],
});

type Msg = AgentMachineMsg<Purpose, Outputs, ToolResult>;
type AgentCtx = { readonly now: () => number };

// Checkpointing is off on this agent, so `snapshot_write` is config-derived out
// of the emitted Cmd set and the obligation forbids the handler — the interpret
// covers the consumer's own tool Cmds and nothing else.
const toolInterpret: Interpret<Msg, ToolCmd, AgentCtx> = {
  run_crawl: async (cmd, ctx) => {
    const urls = await runCrawlSubRun();
    return {
      type: "agent_tool_ok",
      callId: cmd.callId,
      result: { kind: "sitemap", urls },
      at: ctx.now(),
    };
  },
  run_audit: async (cmd, ctx) => {
    const url = urlOfAuditCall(cmd.callId);
    const at = ctx.now();
    const id = `intake:${cmd.callId}`;
    let received: readonly IntakeCmd<string, AuditFinding>[];
    [intakeState, received] = intake.receive(intakeState, url, at, id);
    const { finding, disposition } = await settleIntake(received, ctx.now());
    return {
      type: "agent_tool_ok",
      callId: cmd.callId,
      result: { kind: "audit", finding, disposition },
      at: ctx.now(),
    };
  },
};

const agentWired = agent.toMachine<AgentCtx>({ toolInterpret });
const agentMachine = agentWired.machine;

type ReportSink = {
  readonly shipReport: (report: string) => Promise<string>;
};

// The report ship, hand-wired: a named resilient-call knob (`publish_run` /
// `publish_run_ok` / `publish_run_err`) the uploader calls from its own
// `update`. Circuit + rate limit + retry gate the ship, and the `deadline`
// brick caps it — plain functions over the uploader's own slice.
const publish = createResilientCall<string, string, "publish">(
  {
    name: "publish",
    circuit: { threshold: 3, cooldownMs: 1 },
    rateLimit: { capacity: 4, refillPerSec: 64 },
    retry: { baseMs: 1, factor: 2, capMs: 4, maxAttempts: 5, jitter: "none" },
    deadline: { ms: 600_000 },
  },
  () => 0,
);

const SINK_KEY = "report-sink";

type UploaderState = {
  readonly phase: "idle" | "shipping" | "shipped" | "failed";
  readonly sink: ResilientState<string, string>;
};
type UploaderMsg =
  | { readonly type: "ship"; readonly report: string; readonly at: number }
  | ResilientTimerMsg<"publish">;

/** The uploader's phase, read off the settled sink call. */
function phaseOf(sink: UploaderState["sink"]): UploaderState["phase"] {
  const call = sink.calls[SINK_KEY];
  if (call?.phase === "succeeded") return "shipped";
  if (call?.phase === "failed") return "failed";
  return "shipping";
}

const uploaderMachine = defineMachine({
  types: {
    model: {} as UploaderState,
    msg: {} as UploaderMsg,
    ctx: {} as ReportSink,
  },
  cmds: [publish.run],
  init: (loaded) =>
    loaded !== null ? [loaded, []] : [{ phase: "idle", sink: publish.init() }, []],
  update: {
    ship: (s, m) => {
      const [sink, cmds] = publish.attempt(s.sink, SINK_KEY, m.report, m.at);
      return [{ phase: phaseOf(sink), sink }, cmds];
    },
    publish_run_ok: (s, m) => {
      const { call: sink, cmds } = publish.settle(s.sink, m);
      return [{ phase: phaseOf(sink), sink }, cmds];
    },
    publish_run_err: (s, m) => {
      const { call: sink, cmds } = publish.settle(s.sink, m);
      return [{ phase: phaseOf(sink), sink }, cmds];
    },
    publish_deadline: (s, m) => {
      const [sink, cmds] = publish.onTimer(s.sink, m);
      return [{ phase: phaseOf(sink), sink }, cmds];
    },
  },
  // The retry and deadline timers. `timer` is built into the engine.
  subs: [{ type: "timer", deps: (s: UploaderState) => publish.timer(s.sink) }],
});

const uploaderInterpret: Interpret<
  UploaderMsg,
  ReturnType<typeof publish.run>,
  ReportSink
> = {
  publish_run: async (cmd, ctx) => {
    try {
      return ctx.ok(await ctx.shipReport(cmd.input));
    } catch (cause) {
      return ctx.err({ _tag: "port_rejected", cause: String(cause) });
    }
  },
};

type UploaderMetric = { readonly seq: number; readonly msgType: string };
const uploaderMetrics: UploaderMetric[] = [];
let sinkArmed = true;
let sinkThrows = 0;

const line = (label: string) =>
  console.log(`\n== ${label} ${"=".repeat(Math.max(0, 56 - label.length))}`);

async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 4000; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`timed out waiting for: ${label}`);
}


async function main() {
  const ctx: AgentCtx = {
    now: () => Date.now(),
  };

  line("assembling Optimus from the @demlik/tea stack");
  console.log(
    "L1 bricks -> L2 compositions -> L3 agent -> DevX",
  );
  console.log("");
  console.log(
    "  agent      = createAgent(plan->crawl->audit->report).toMachine()",
  );
  console.log(
    "               its fold loop (llm -> tools -> fold -> llm) runs",
  );
  console.log(
    "               ENTIRELY inside the reducer: each tool interpret",
  );
  console.log(
    "               cell returns agent_tool_ok, the substrate re-enters",
  );
  console.log("               it, settleTool folds it. No consumer glue.");
  console.log("");
  console.log("  run_crawl  -> paginated-walk SUB-RUN over the fake sitemap");
  console.log(
    "               (start/pageOk emit resilient fetch Cmds; page_ok",
  );
  console.log("               routes back; URLs come from the walk, retry+");
  console.log("               rateLimit gate every page fetch)");
  console.log("  run_audit  -> idempotent-intake.receive() decides process vs");
  console.log(
    "               replay; a fresh URL runs a resilient-call SUB-RUN",
  );
  console.log(
    "               (circuit+retry) so the flaky /pricing page retries",
  );
  console.log(
    "               and recovers; the duplicate /docs replays cached.",
  );
  console.log("");
  console.log("  uploader   = a machine that hand-wires a named resilient-call");
  console.log("               knob (publish_run) into its own update");
  console.log(
    "               the agent hands it the report; the knob's plain",
  );
  console.log(
    "               functions retry the flaky sink and cap the ship, and",
  );
  console.log("               run's telemetry sink records every uploader");
  console.log("               transition to uploaderMetrics[].");

  line("the agent loop, narrated");

  const runtime = await run(agentMachine, { ...agentWired, ctx }).ready;
  const rec = recorder(runtime);

  let lastStage: Stage | undefined;
  runtime.observe((msg, _state) => {
    if (msg === null) return;

    if (msg.type === "resilient_run_ok") {
      const out = msg.value.output as AgentTurn;
      const purpose = msg.cmd.key as Purpose;
      if (purpose !== lastStage) {
        console.log(`\n> stage: ${purpose}`);
        lastStage = purpose;
      }
      console.log(`  - brain: "${out.content}"`);
      if (out.toolCalls.length === 0) {
        console.log(
          purpose === "report"
            ? "    -> no tool calls -> pipeline complete -> done"
            : "    -> no tool calls -> stage done -> advance",
        );
      } else if (out.toolCalls.length === 1) {
        console.log(`    -> 1 tool call: ${out.toolCalls[0]?.name}`);
      } else {
        console.log(
          `    -> FAN-OUT ${out.toolCalls.length} audit calls (serial; one is a re-audit of /docs)`,
        );
      }
    }

    if (msg.type === "agent_tool_ok") {
      const result = msg.result;
      if (result.kind === "sitemap") {
        console.log(
          `  - crawl ok: paginated-walk discovered ${result.urls.length} URLs ${JSON.stringify(result.urls)}`,
        );
      } else {
        const f = result.finding;
        console.log(
          result.disposition === "replay"
            ? `  - audit ok [${f.url}]: intake.receive() -> intake:replay -> SKIPPED re-audit, replayed cached finding (${f.violations} violation(s))`
            : `  - audit ok [${f.url}]: intake.receive() -> intake:process -> ${f.violations} violation(s) - ${f.note}`,
        );
      }
    }
  });

  await runtime.dispatch({
    type: "agent_start",
    runId: "crawl-audit-001",
    at: ctx.now(),
  });

  await until(() => {
    const agentState = runtime.getState();
    return agent.isSettled(agentState);
  }, "agent run settles");

  const finalAgent = runtime.getState();

  line("resilience-on-the-fold-tool: plain functions at the audit call");
  console.log(
    "the run_audit tool runs a createResilientCall SUB-RUN (circuit+retry).",
  );
  console.log(
    `audit('/pricing') hit the flaky engine: 1 throw, then recovered (flakyHits=${flakyHits})`,
  );
  console.log(
    `audit-engine retries fired across the run: ${auditEngineRetries}`,
  );
  console.log(
    "the agent fold loop stays pure: this resilience lives in the tool I/O.",
  );

  line("paginated-walk: the crawl genuinely walked the sitemap");
  console.log(`page fetches issued THROUGH the composition: ${walkFetches}`);
  console.log(
    `walk page retries (resilient half: 429 on p2 -> backoff -> recover): ${walkRetries}`,
  );

  line("idempotent-intake: dedupe driven through receive()");
  console.log(`pages audited fresh   : ${auditedFresh} (intake:process)`);
  console.log(
    `pages skipped (replay): ${auditedSkipped} (intake:replay -> re-audit SKIPPED)`,
  );
  console.log(`replayed keys         : ${JSON.stringify(intakeReplays)}`);
  console.log(
    `intake done-keys      : ${Object.keys(intakeState.seen.entries).length} (one per unique URL)`,
  );

  line("final report from the agent");
  const agentSlice = finalAgent;
  const runId = "runId" in agentSlice.run ? agentSlice.run.runId : "(idle)";
  console.log(`run.runId  : ${runId}`);
  console.log(`run.phase  : ${agentSlice.run.phase}`);
  console.log(`failure    : ${JSON.stringify(agentSlice.failure)}`);
  console.log(`settled?   : ${agent.isSettled(agentSlice)}`);
  console.log(`report     : "${reportTurn.content}"`);

  await runtime.stop();

  line("hand-wired resilient-call + telemetry: ship the report");
  console.log(
    "the agent hands the finished report to the uploader machine.",
  );
  const shipReport = async (report: string): Promise<string> => {
    if (sinkArmed) {
      sinkArmed = false;
      sinkThrows += 1;
      throw new Error("external report sink unavailable (transient)");
    }
    return `receipt:${report.length}`;
  };

  const uploaderRuntime = await run(uploaderMachine, {
    interpret: uploaderInterpret,
    ctx: { shipReport },
    telemetry: (e) => {
      uploaderMetrics.push({ seq: e.seq, msgType: e.msgType });
    },
  }).ready;

  await uploaderRuntime.dispatch({
    type: "ship",
    report: reportTurn.content,
    at: Date.now(),
  });

  await until(() => {
    const phase = uploaderRuntime.getState().phase;
    return phase === "shipped" || phase === "failed";
  }, "flaky sink retries then recovers");

  const finalUploader = uploaderRuntime.getState();
  const sinkCall = finalUploader.sink.calls[SINK_KEY];
  console.log(
    `  - sink threw once (sinkThrows=${sinkThrows}) -> publish.settle armed a retry`,
  );
  console.log(
    `  - retry timer fired -> sink recovered -> call phase: ${sinkCall?.phase}`,
  );
  console.log(
    `circuit phase: ${finalUploader.sink.circuit.phase} (absorbed, then closed)`,
  );
  console.log(
    `uploader phase: ${finalUploader.phase} (read off the settled call — the uploader's own update)`,
  );

  line("telemetry: every uploader transition sunk to metrics[]");
  console.log(`uploaderMetrics captured ${uploaderMetrics.length} transitions`);
  const counts: Record<string, number> = {};
  for (const m of uploaderMetrics)
    counts[m.msgType] = (counts[m.msgType] ?? 0) + 1;
  console.log(`  by type: ${JSON.stringify(counts)}`);

  await uploaderRuntime.stop();

  line("DevX payoff on the agent machine");
  const trace = rec.dump();
  rec.stop();
  console.log(
    `recorder captured ${trace.msgs.length} msgs from the agent machine`,
  );

  for (const k of Object.keys(attempts) as Purpose[]) attempts[k] = 0;
  flakyArmed = true;
  flakyHits = 0;
  auditEngineRetries = 0;
  walkFetches = 0;
  walkRetries = 0;
  walkPageFlakyArmed = true;
  intakeState = intake.init();
  auditedFresh = 0;
  auditedSkipped = 0;
  intakeReplays.length = 0;

  const replayResult = replayTrace(agentMachine, trace, {
    now: () => 0,
  });
  console.log(
    `trace-replay against the same reducer -> matches: ${replayResult.matches}`,
  );
  if (!replayResult.matches && replayResult.divergence !== undefined) {
    console.log(`  divergence at ${replayResult.divergence.path}`);
  }

  const diagram = toMermaid(agentMachine, {
    title: "Optimus - assembled crawl-and-audit agent",
  });
  console.log("\nmachine-viz Mermaid diagram of the agent machine:\n");
  console.log(diagram);

  line("the point");
  console.log(
    "The L3 agent fold loop is pure INSIDE the reducer (tool cells return",
  );
  console.log(
    "agent_tool_ok, the substrate re-enters it). Two L2 sub-runs genuinely",
  );
  console.log(
    "drive the crawl (paginated-walk) and the flaky audit (resilient-call).",
  );
  console.log(
    "idempotent-intake decides process vs replay through receive(). The two",
  );
  console.log(
    "uploader hand-wires a resilient report ship. Faked: the model,",
  );
  console.log("the site, the sinks, and the clock - nothing else.");
}

void main();
