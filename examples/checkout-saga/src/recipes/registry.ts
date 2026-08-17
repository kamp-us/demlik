/// <reference types="@cloudflare/workers-types" />
/**
 * The five recipe machines, wrapped in ONE uniform surface so a single generic
 * Durable Object can host any of them and a single set of rendering helpers can
 * draw any of them.
 *
 * Each adapter exposes the same handful of reads — phase, facts, chips,
 * narrative, available actions — plus `apply`, which turns a button id into a
 * dispatch. Everything a panel shows is derived from the machine's own State,
 * so the UI cannot drift from what the saga actually believes.
 *
 * ── On the ⏩ buttons ────────────────────────────────────────────────────────
 * Every one of these machines is pure over `now`: the reducer never reads a
 * clock, it receives `at` on the Msg. So "three days pass" is not a simulation
 * — it is the same `tick` Msg the alarm would deliver, with the timestamp the
 * alarm would have carried. That is the entire trick, and it is why a
 * day-scale workflow can be demonstrated in a click. In production the ⏩
 * buttons are Durable Object alarms.
 */

import { ManagedRuntime } from "effect";
import {
  type DurableTimer,
  doStore,
  durableTimer,
} from "../../../../src/do/index";
import { type Interpret, type Runtime, run } from "../../../../src/index";
import * as approval from "../../../recipes/approval-chain/machine";
import * as dunning from "../../../recipes/dunning/machine";
import * as agentHandlers from "../../../recipes/durable-agent-run/handlers";
import * as agent from "../../../recipes/durable-agent-run/machine";
import * as agentServices from "../../../recipes/durable-agent-run/services";
import * as fleet from "../../../recipes/fleet-reconcile/machine";
import * as drip from "../../../recipes/onboarding-drip/machine";

// ── The uniform surface ─────────────────────────────────────────────────────

export interface Fact {
  readonly label: string;
  readonly value: string;
}

export type ChipStatus = "done" | "active" | "pending" | "failed" | "cancelled";

export interface Chip {
  readonly label: string;
  readonly status: ChipStatus;
}

export interface ActionSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: "primary" | "time" | "danger" | "plain";
  readonly enabled: boolean;
}

export interface RecipeInstance {
  phase(): string;
  terminal(): boolean;
  dueAt(): number | null;
  facts(): readonly Fact[];
  chips(): readonly Chip[];
  /** Flat, append-only prose. The host logs the DELTA after each dispatch. */
  narrative(): readonly string[];
  actions(): readonly ActionSpec[];
  apply(action: string, now: number): Promise<void>;
  stop(): Promise<void>;
}

export interface RecipeAdapter {
  readonly id: string;
  readonly title: string;
  /** What real-world thing this is. One line, plain English. */
  readonly realWorld: string;
  /** The insight the recipe exists to show. */
  readonly insight: string;
  readonly phases: readonly string[];
  boot(storage: DurableObjectStorage): Promise<RecipeInstance>;
}

const DAY = 24 * 60 * 60 * 1000;

/** Milliseconds as a human duration, for the ⏩ button labels. */
function human(ms: number): string {
  if (ms >= DAY) {
    const days = ms / DAY;
    return `${days % 1 === 0 ? days : days.toFixed(1)} day${days === 1 ? "" : "s"}`;
  }
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** The ⏩ label for a machine whose next deadline is `dueAt`. */
function skipLabel(dueAt: number | null, now: number, what: string): string {
  if (dueAt === null) return `⏩ ${what}`;
  const gap = Math.max(0, dueAt - now);
  return `⏩ ${human(gap)} pass — ${what}`;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// ── 1. durable-agent-run ────────────────────────────────────────────────────

const AGENT_SCRIPT: readonly agentServices.ScriptedStep[] = [
  {
    output: "step 1: read the support ticket and the order history",
    costUsd: 0.12,
    failuresBeforeSuccess: 1,
  },
  {
    output: "step 2: drafted a resolution — this one needs a human",
    costUsd: 0.2,
    needsApproval: "issue a $40 refund to the customer",
  },
  { output: "step 3: posted the reply and closed the ticket", costUsd: 0.15 },
];

const agentRunAdapter: RecipeAdapter = {
  id: "durable-agent-run",
  title: "Durable agent run",
  realWorld:
    "An AI agent working a support ticket over several model calls, with a spend cap and a human approval in the middle.",
  insight:
    "The approval wait has no timer at all. Nothing is scheduled — the run simply stops until a human says yes, which may be days and several deploys later. A process holding a promise cannot wait that long. A row can.",
  phases: ["idle", "running", "awaiting-approval", "done", "failed"],

  async boot(storage) {
    const managed = ManagedRuntime.make(
      agentServices.ProviderFake(AGENT_SCRIPT),
    );
    const rt = await run(
      agent.agentRunMachine(agentHandlers.agentInterpret(managed)),
      {
        ctx: {},
        store: doStore<agent.State>(storage, agent.parseState),
        terminal: agent.isTerminal,
      },
    ).ready;

    const s = () => rt.getState();
    return {
      phase: () => s().phase,
      terminal: () => agent.isTerminal(s()),
      dueAt: () => s().nextRetryAt,
      facts: () => [
        { label: "step", value: `${s().step} of ${s().maxSteps}` },
        {
          label: "spent",
          value: `$${s().spentUsd.toFixed(2)} of $${s().budgetUsd.toFixed(2)}`,
        },
        { label: "attempt", value: String(s().attempt || "—") },
        {
          label: "waiting on",
          value: s().pendingApproval?.action ?? "—",
        },
      ],
      chips: () => {
        const state = s();
        const out: Chip[] = [];
        for (let i = 1; i <= state.maxSteps; i++) {
          out.push({
            label: `step ${i}`,
            status:
              i <= state.step
                ? "done"
                : i === state.step + 1
                  ? state.phase === "failed"
                    ? "failed"
                    : "active"
                  : "pending",
          });
        }
        return out;
      },
      narrative: () => s().transcript,
      actions: () => {
        const state = s();
        const done = agent.isTerminal(state);
        return [
          {
            id: "start",
            label: state.phase === "idle" ? "Start the run" : "Restart",
            kind: "primary",
            enabled: true,
          },
          {
            id: "approve",
            label: "✅ Approve the refund",
            kind: "primary",
            enabled: state.phase === "awaiting-approval",
          },
          {
            id: "deny",
            label: "🚫 Reject",
            kind: "plain",
            enabled: state.phase === "awaiting-approval",
          },
          {
            id: "skip",
            label: skipLabel(state.nextRetryAt, Date.now(), "next retry"),
            kind: "time",
            enabled: state.nextRetryAt !== null,
          },
          { id: "crash", label: "💥 Kill", kind: "danger", enabled: !done },
        ];
      },
      async apply(action, now) {
        if (action === "start") {
          await rt.dispatch({
            type: "start",
            runId: `run-${now.toString(36).slice(-4)}`,
            goal: "resolve support ticket #4021",
            at: now,
          });
        } else if (action === "approve") {
          await rt.dispatch({ type: "approval_granted", by: "can", at: now });
        } else if (action === "deny") {
          await rt.dispatch({
            type: "approval_denied",
            by: "can",
            reason: "refund too large for this plan",
            at: now,
          });
        } else if (action === "skip") {
          const due = rt.getState().nextRetryAt;
          if (due !== null) await rt.dispatch({ type: "tick", at: due });
        }
      },
      async stop() {
        await rt.stop();
        await managed.dispose();
      },
    };
  },
};

// ── 2. dunning ──────────────────────────────────────────────────────────────

const dunningAdapter: RecipeAdapter = {
  id: "dunning",
  title: "Dunning",
  realWorld:
    "A subscription whose card was declined: billing retries on day 1, day 3 and day 7, then a 14-day grace period, then a downgrade.",
  insight:
    "A 21-day process cannot live in a process. There is no runtime you can hold open for three weeks, so the schedule is not a schedule — it is arithmetic on a number in a row.",
  phases: ["idle", "retrying", "grace", "downgraded", "recovered"],

  async boot(storage) {
    // `charge` comes back declined; the operator's button is what makes money
    // arrive. `notify` / `downgrade` are fire-and-forget.
    let self: Runtime<dunning.State, dunning.Msg> | null = null;
    const interpret: Interpret<dunning.Msg, dunning.Cmd, dunning.Ctx> = {
      charge: async () =>
        ({
          type: "charge_declined",
          reason: "card declined (insufficient funds)",
          at: self?.getState().dueAt ?? Date.now(),
        }) as const,
      notify: async () => {},
      downgrade: async () => {},
    };
    const rt = await run(dunning.dunningMachine(interpret), {
      ctx: {},
      store: doStore<dunning.State>(storage, dunning.parseState),
      terminal: dunning.isTerminal,
    }).ready;
    self = rt;

    const s = () => rt.getState();
    return {
      phase: () => s().phase,
      terminal: () => dunning.isTerminal(s()),
      dueAt: () => s().dueAt,
      facts: () => [
        { label: "amount", value: money(s().amountCents) },
        {
          label: "retries used",
          value: `${Math.min(s().rung, dunning.RETRY_OFFSETS_MS.length)} of ${dunning.RETRY_OFFSETS_MS.length}`,
        },
        { label: "declines", value: String(s().declines.length) },
      ],
      chips: () => {
        const state = s();
        const out: Chip[] = dunning.RETRY_OFFSETS_MS.map((offset, i) => ({
          label: `day ${offset / DAY}`,
          status: (state.phase === "recovered" && i >= state.rung
            ? "cancelled"
            : i < state.rung
              ? "failed"
              : i === state.rung && state.phase === "retrying"
                ? "active"
                : "pending") as ChipStatus,
        }));
        out.push({
          label: "grace 14d",
          status:
            state.phase === "grace"
              ? "active"
              : state.phase === "downgraded"
                ? "done"
                : state.phase === "recovered"
                  ? "cancelled"
                  : "pending",
        });
        out.push({
          label: state.phase === "recovered" ? "recovered" : "downgrade",
          status:
            state.phase === "downgraded"
              ? "failed"
              : state.phase === "recovered"
                ? "done"
                : "pending",
        });
        return out;
      },
      narrative: () => {
        const state = s();
        const lines = state.declines.map(
          (d, i) => `retry ${i} declined: ${d.reason}`,
        );

        // Append-only: keyed on the LADDER being spent, not on the current
        // phase, so this line does not vanish when grace turns into a downgrade.
        if (state.rung >= dunning.RETRY_OFFSETS_MS.length)
          lines.push("ladder spent — 14-day grace period opened");
        if (state.phase === "downgraded")
          lines.push("grace expired — account downgraded");
        if (state.phase === "recovered")
          lines.push("payment arrived — dunning closed, subscription active");
        return lines;
      },
      actions: () => {
        const state = s();
        const done = dunning.isTerminal(state);
        const rung = state.rung;
        return [
          {
            id: "start",
            label:
              state.phase === "idle"
                ? "Card declined — open dunning"
                : "Restart",
            kind: "primary",
            enabled: state.phase === "idle",
          },
          {
            id: "skip",
            label: skipLabel(
              state.dueAt,
              Date.now(),
              state.phase === "grace"
                ? "grace expires"
                : `retry on day ${(dunning.RETRY_OFFSETS_MS[rung] ?? 0) / DAY}`,
            ),
            kind: "time",
            enabled: state.dueAt !== null && !done,
          },
          {
            id: "pay",
            label: "💳 Card succeeds",
            kind: "primary",
            enabled: state.phase === "retrying" || state.phase === "grace",
          },
          { id: "crash", label: "💥 Kill", kind: "danger", enabled: !done },
        ];
      },
      async apply(action, now) {
        if (action === "start") {
          await rt.dispatch({
            type: "renewal_declined",
            subscriptionId: `sub-${now.toString(36).slice(-4)}`,
            amountCents: 2900,
            reason: "card declined (insufficient funds)",
            at: now,
          });
        } else if (action === "skip") {
          const due = rt.getState().dueAt;
          if (due !== null) await rt.dispatch({ type: "tick", at: due });
        } else if (action === "pay") {
          await rt.dispatch({ type: "payment_succeeded", at: now });
        }
      },
      async stop() {
        await rt.stop();
      },
    };
  },
};

// ── 3. approval-chain ───────────────────────────────────────────────────────

const APPROVERS = ["dept-head", "finance", "cfo"] as const;

const approvalAdapter: RecipeAdapter = {
  id: "approval-chain",
  title: "Approval chain",
  realWorld:
    "An expense report walking three approvers in order, each chased with a reminder after two days and an escalation after seven.",
  insight:
    "State IS the audit log. Who approved what, when, and what we chased them with all live in the same row the machine runs on — so there is no separate events table for a failed write to desynchronise.",
  phases: ["draft", "pending", "approved", "rejected"],

  async boot(storage) {
    const interpret: Interpret<approval.Msg, approval.Cmd, approval.Ctx> = {
      notify_approver: async () => {},
      escalate: async () => {},
    };
    const rt = await run(approval.approvalChainMachine(interpret), {
      ctx: {},
      store: doStore<approval.State>(storage, approval.parseState),
      terminal: approval.isTerminal,
    }).ready;

    const s = () => rt.getState();
    return {
      phase: () => s().phase,
      terminal: () => approval.isTerminal(s()),
      dueAt: () => s().dueAt,
      facts: () => {
        const state = s();
        return [
          { label: "amount", value: money(state.amountCents) },
          {
            label: "ball is with",
            value:
              state.phase === "pending"
                ? (state.approvers[state.cursor] ?? "—")
                : "—",
          },
          { label: "decisions", value: String(state.decisions.length) },
          {
            label: "chased",
            value:
              state.escalatedAt !== null
                ? "escalated"
                : state.remindedAt !== null
                  ? "reminded"
                  : "—",
          },
        ];
      },
      chips: () => {
        const state = s();
        return state.approvers.map((name, i) => {
          const decision = state.decisions[i];
          if (decision !== undefined) {
            return {
              label: name,
              status: (decision.verdict === "approved"
                ? "done"
                : "failed") as ChipStatus,
            };
          }
          if (state.phase === "rejected") {
            return { label: name, status: "cancelled" as ChipStatus };
          }
          return {
            label: name,
            status: (state.phase === "pending" && i === state.cursor
              ? "active"
              : "pending") as ChipStatus,
          };
        });
      },
      narrative: () => {
        const state = s();
        const events: { at: number; text: string }[] = [
          ...state.notices.map((n) => ({
            at: n.at,
            text:
              n.kind === "assigned"
                ? `assigned to ${n.approver}`
                : n.kind === "reminded"
                  ? `reminder sent to ${n.approver} (2 days of silence)`
                  : `escalated past ${n.approver} to their manager (7 days)`,
          })),
          ...state.decisions.map((d) => ({
            at: d.at,
            text: `${d.approver} ${d.verdict}${d.comment ? `: ${d.comment}` : ""}`,
          })),
        ];
        events.sort((a, b) => a.at - b.at);
        return events.map((e) => e.text);
      },
      actions: () => {
        const state = s();
        const done = approval.isTerminal(state);
        const current = state.approvers[state.cursor];
        const out: ActionSpec[] = [
          {
            id: "start",
            label:
              state.phase === "draft" ? "Submit the expense report" : "Restart",
            kind: "primary",
            enabled: state.phase === "draft",
          },
        ];
        for (const name of APPROVERS) {
          out.push({
            id: `approve@${name}`,
            label: `✅ ${name} approves`,
            kind: "primary",
            enabled: state.phase === "pending" && current === name,
          });
          out.push({
            id: `reject@${name}`,
            label: `🚫 ${name} rejects`,
            kind: "plain",
            enabled: state.phase === "pending" && current === name,
          });
        }
        out.push({
          id: "skip",
          label: skipLabel(
            state.dueAt,
            Date.now(),
            state.remindedAt === null ? "reminder fires" : "escalation fires",
          ),
          kind: "time",
          enabled: state.dueAt !== null && !done,
        });
        out.push({
          id: "crash",
          label: "💥 Kill",
          kind: "danger",
          enabled: !done,
        });
        return out;
      },
      async apply(action, now) {
        if (action === "start") {
          await rt.dispatch({
            type: "submit",
            requestId: `exp-${now.toString(36).slice(-4)}`,
            amountCents: 128_00,
            approvers: [...APPROVERS],
            at: now,
          });
          return;
        }
        if (action === "skip") {
          const due = rt.getState().dueAt;
          if (due !== null) await rt.dispatch({ type: "tick", at: due });
          return;
        }
        const [verb, approver] = action.split("@");
        if (
          approver !== undefined &&
          (verb === "approve" || verb === "reject")
        ) {
          await rt.dispatch({
            type: "decide",
            approver,
            verdict: verb === "approve" ? "approved" : "rejected",
            comment:
              verb === "reject" ? "not budgeted this quarter" : undefined,
            at: now,
          });
        }
      },
      async stop() {
        await rt.stop();
      },
    };
  },
};

// ── 4. onboarding-drip ──────────────────────────────────────────────────────

const dripAdapter: RecipeAdapter = {
  id: "onboarding-drip",
  title: "Onboarding drip",
  realWorld:
    "A new signup gets a welcome on day 1, a tip on day 3 and a check-in on day 7 — and the moment they actually use the product, the rest are cancelled.",
  insight:
    "Cancelling is deleting a number, not revoking a job. There is no queue to scan and no scheduler entry to chase: the due time becomes null and the drip is over.",
  phases: ["idle", "scheduled", "completed"],

  async boot(storage) {
    const interpret: Interpret<drip.Msg, drip.Cmd, drip.Ctx> = {
      send_email: async () => {},
    };
    const rt = await run(drip.onboardingDripMachine(interpret), {
      ctx: {},
      store: doStore<drip.State>(storage, drip.parseState),
      terminal: drip.isTerminal,
    }).ready;

    const s = () => rt.getState();
    return {
      phase: () => s().phase,
      terminal: () => drip.isTerminal(s()),
      dueAt: () => s().dueAt,
      facts: () => {
        const state = s();
        return [
          {
            label: "sent",
            value: `${state.sent.length} of ${drip.DRIP.length}`,
          },
          { label: "cancelled", value: String(drip.unsent(state).length) },
          {
            label: "ended by",
            value:
              state.endedBy === "activity"
                ? `activity: ${state.cancelledBy?.what ?? "?"}`
                : (state.endedBy ?? "—"),
          },
        ];
      },
      chips: () => {
        const state = s();
        return drip.DRIP.map((step, i) => ({
          label: `${step.template} (d${step.offsetMs / DAY})`,
          status: (i < state.cursor
            ? "done"
            : state.phase === "completed"
              ? "cancelled"
              : i === state.cursor
                ? "active"
                : "pending") as ChipStatus,
        }));
      },
      narrative: () => {
        const state = s();
        const lines = state.sent.map((x) => `sent "${x.template}"`);
        if (state.endedBy === "activity") {
          lines.push(
            `user became active (${state.cancelledBy?.what ?? "?"}) — cancelled: ${drip.unsent(state).join(", ") || "nothing"}`,
          );
        } else if (state.endedBy === "finished") {
          lines.push("drip finished — every send went out");
        }
        return lines;
      },
      actions: () => {
        const state = s();
        const done = drip.isTerminal(state);
        const next = drip.DRIP[state.cursor];
        return [
          {
            id: "start",
            label: state.phase === "idle" ? "Enrol a new signup" : "Restart",
            kind: "primary",
            enabled: state.phase === "idle",
          },
          {
            id: "skip",
            label: skipLabel(
              state.dueAt,
              Date.now(),
              next ? `send "${next.template}"` : "finish",
            ),
            kind: "time",
            enabled: state.dueAt !== null && !done,
          },
          {
            id: "active",
            label: "🎉 User became active",
            kind: "primary",
            enabled: state.phase === "scheduled",
          },
          { id: "crash", label: "💥 Kill", kind: "danger", enabled: !done },
        ];
      },
      async apply(action, now) {
        if (action === "start") {
          await rt.dispatch({
            type: "enrolled",
            userId: `user-${now.toString(36).slice(-4)}`,
            at: now,
          });
        } else if (action === "skip") {
          const due = rt.getState().dueAt;
          if (due !== null) await rt.dispatch({ type: "tick", at: due });
        } else if (action === "active") {
          await rt.dispatch({
            type: "user_active",
            what: "created their first project",
            at: now,
          });
        }
      },
      async stop() {
        await rt.stop();
      },
    };
  },
};

// ── 5. fleet-reconcile ──────────────────────────────────────────────────────

const CONFIGS: Record<string, fleet.DeviceConfig> = {
  a: { firmware: "2.1.0", telemetry: true, sampleHz: 10 },
  b: { firmware: "2.2.0", telemetry: true, sampleHz: 50 },
};

/** Pushes fail while the attempt count is below this, then go through. */
const PUSH_FAILURES = 2;

const fleetAdapter: RecipeAdapter = {
  id: "fleet-reconcile",
  title: "Fleet reconcile",
  realWorld:
    "One device with a desired config and a reported config: push when they differ, back off when the push fails, stop when the device confirms.",
  insight:
    "Reconcile is a loop, and a loop that survives has to be re-entrant from state alone. Nothing remembers 'I was halfway through a push' — the revision numbers and the attempt count say it all, so any wake-up can recompute what is owed.",
  phases: ["unknown", "pushing", "awaiting-report", "backoff", "converged"],

  async boot(storage) {
    let self: Runtime<fleet.State, fleet.Msg> | null = null;
    const interpret: Interpret<fleet.Msg, fleet.Cmd, fleet.Ctx> = {
      // Deterministic in the PERSISTED attempt count, so a resumed push behaves
      // exactly like one that never died.
      push_config: async (cmd) => {
        const attempt = self?.getState().attempt ?? 0;
        const at = Date.now();
        return attempt < PUSH_FAILURES
          ? ({
              type: "push_failed",
              rev: cmd.rev,
              reason: `device unreachable (attempt ${attempt + 1})`,
              at,
            } as const)
          : ({ type: "push_ok", rev: cmd.rev, at } as const);
      },
    };
    const rt = await run(fleet.fleetReconcileMachine(interpret), {
      ctx: {},
      store: doStore<fleet.State>(storage, fleet.parseState),
      terminal: fleet.isConverged,
    }).ready;
    self = rt;

    const s = () => rt.getState();
    const describe = (config: fleet.DeviceConfig | null): string =>
      config === null ? "—" : `${config.firmware} @ ${config.sampleHz}Hz`;

    return {
      phase: () => s().phase,
      terminal: () => fleet.isConverged(s()),
      dueAt: () => s().dueAt,
      facts: () => {
        const state = s();
        return [
          {
            label: "desired",
            value: `${describe(state.desired)} (rev ${state.desiredRev})`,
          },
          { label: "reported", value: describe(state.reported) },
          { label: "push attempt", value: String(state.attempt || "—") },
          { label: "last error", value: state.lastError ?? "—" },
        ];
      },
      chips: () => {
        const state = s();
        const order: fleet.Phase[] = [
          "unknown",
          "pushing",
          "awaiting-report",
          "backoff",
          "converged",
        ];
        return order.map((p) => ({
          label: p,
          status: (state.phase === p
            ? p === "converged"
              ? "done"
              : "active"
            : "pending") as ChipStatus,
        }));
      },
      narrative: () => {
        const state = s();
        const lines: string[] = [];
        if (state.desired !== null) {
          lines.push(
            `desired config set to ${describe(state.desired)} (rev ${state.desiredRev})`,
          );
        }
        if (state.attempt > 0) {
          lines.push(`${state.attempt} push attempt(s) failed — backing off`);
        }
        if (state.lastError !== null)
          lines.push(`last error: ${state.lastError}`);
        if (state.phase === "awaiting-report") {
          lines.push("push accepted — waiting for the device to confirm");
        }
        if (state.phase === "converged") {
          lines.push(`converged on ${describe(state.reported)}`);
        }
        return lines;
      },
      actions: () => {
        const state = s();
        return [
          {
            id: "desire@a",
            label: "Set desired: 2.1.0 @ 10Hz",
            kind: "primary",
            enabled: true,
          },
          {
            id: "desire@b",
            label: "Set desired: 2.2.0 @ 50Hz",
            kind: "primary",
            enabled: true,
          },
          {
            id: "drift",
            label: "📡 Device reports drift",
            kind: "plain",
            enabled: state.desired !== null,
          },
          {
            id: "confirm",
            label: "📡 Device reports desired config",
            kind: "plain",
            enabled: state.desired !== null,
          },
          {
            id: "skip",
            label: skipLabel(
              state.dueAt,
              Date.now(),
              state.phase === "backoff" ? "retry the push" : "report deadline",
            ),
            kind: "time",
            enabled: state.dueAt !== null,
          },
          {
            id: "crash",
            label: "💥 Kill",
            kind: "danger",
            enabled: state.desired !== null,
          },
        ];
      },
      async apply(action, now) {
        if (action === "skip") {
          const due = rt.getState().dueAt;
          if (due !== null) await rt.dispatch({ type: "tick", at: due });
          return;
        }
        if (action === "drift") {
          await rt.dispatch({
            type: "reported",
            config: { firmware: "1.9.3", telemetry: false, sampleHz: 1 },
            at: now,
          });
          return;
        }
        if (action === "confirm") {
          const desired = rt.getState().desired;
          if (desired !== null) {
            await rt.dispatch({ type: "reported", config: desired, at: now });
          }
          return;
        }
        const [verb, key] = action.split("@");
        if (verb === "desire" && key !== undefined) {
          const config = CONFIGS[key];
          if (config !== undefined) {
            await rt.dispatch({
              type: "set_desired",
              deviceId: "device-7",
              config,
              at: now,
            });
          }
        }
      },
      async stop() {
        await rt.stop();
      },
    };
  },
};

// ── Registry ────────────────────────────────────────────────────────────────

export const RECIPES: readonly RecipeAdapter[] = [
  agentRunAdapter,
  dunningAdapter,
  approvalAdapter,
  dripAdapter,
  fleetAdapter,
];

export function findRecipe(id: string): RecipeAdapter | undefined {
  return RECIPES.find((r) => r.id === id);
}

export type { DurableTimer };
export { durableTimer };
