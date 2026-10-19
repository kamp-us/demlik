import type { AgentMachineMsg, AgentTurn, ToolCall } from "@demlik/tea/agent";
import { isAgentTurn } from "@demlik/tea/agent";
import { z } from "zod";

export type Evidence = { readonly snippet: string };
export type Msg = AgentMachineMsg<
  "investigate",
  { investigate: AgentTurn },
  Evidence
>;
export type Search = { readonly type: "search" } & ToolCall;
export type CaseRecord = { readonly version: 1; readonly msg: Msg };

export const runIdSchema = z.string().min(1).max(120);
export const evidenceSchema = z.object({ snippet: z.string() }).strict();
export const requestSchema = z.object({ turn: z.number().int().nonnegative() });
export const searchArgsSchema = z.object({ turn: z.number().int().positive() });

const at = z.number().finite().nonnegative();
const id = z.string().min(1);
const purpose = z.literal("investigate");
const compact = z.literal("$compact");
const turn = z.custom<AgentTurn>(isAgentTurn);
const brainCmd = z.object({
  type: z.literal("resilient_run"),
  key: purpose,
  input: z.object({ purpose, model: z.string().nullable(), payload: z.json() }),
});

const msgSchema: z.ZodType<Msg> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent_start"), runId: runIdSchema, at }),
  z.object({ type: z.literal("agent_boot"), at }),
  z.object({ type: z.literal("agent_cancel"), at }),
  z.object({
    type: z.literal("agent_tool_ok"),
    callId: id,
    result: evidenceSchema,
    at,
  }),
  z.object({
    type: z.literal("agent_tool_err"),
    callId: id,
    reason: z.string(),
    at,
  }),
  z.object({
    type: z.literal("resilient_run_ok"),
    cmd: brainCmd,
    value: z.object({ key: purpose, purpose, output: turn }),
    at,
  }),
  z.object({
    type: z.literal("resilient_run_err"),
    cmd: brainCmd,
    error: z.union([
      z.object({
        _tag: z.enum(["port_rejected", "deadline_exceeded"]),
        cause: z.json().optional(),
      }),
      z.object({
        _tag: z.literal("malformed_result"),
        issues: z.array(z.object({ path: z.string(), message: z.string() })),
      }),
    ]),
    at,
  }),
  z.object({
    type: z.literal("compact_ok"),
    key: compact,
    result: z.object({
      key: compact,
      purpose: compact,
      output: z.object({ summary: z.string() }),
    }),
    at,
  }),
  z.object({
    type: z.literal("compact_err"),
    key: compact,
    error: z.object({
      key: compact,
      purpose: compact,
      reason: z.string(),
      error: z.json(),
    }),
    at,
  }),
  z.object({ type: z.literal("deadline_exceeded"), id, atMs: at }),
]);

const recordSchema = z
  .object({ version: z.literal(1), msg: msgSchema })
  .strict();

export function parseRecord(raw: unknown): CaseRecord {
  z.json().parse(raw);
  return recordSchema.parse(raw);
}
