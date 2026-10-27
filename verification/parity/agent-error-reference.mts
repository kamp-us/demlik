import { z } from "zod";
import { compactionSummarySchema } from "../../packages/tea/src/agent/compaction.ts";
import { agentTurnSchema } from "../../packages/tea/src/agent/index.ts";
import { describeError } from "../../packages/tea/src/describe-error.ts";

const input = z.strictObject({
  id: z.string(),
  operation: z.enum(["plain", "guard"]),
  value: z.unknown(),
  summary: z.boolean().optional(),
});
function description(error: unknown) {
  try {
    return { ok: true, value: describeError(error) };
  } catch (e) {
    return e instanceof Error
      ? { ok: false, name: e.name, message: e.message }
      : { ok: false, value: String(e) };
  }
}
let text = "";
for await (const chunk of process.stdin) text += chunk;
const request = input.parse(JSON.parse(text));
let result: unknown;
if (request.operation === "plain")
  result = {
    kind: "plain",
    wire: JSON.parse(JSON.stringify(request.value)),
    description: description(request.value),
  };
else {
  try {
    const value = (
      request.summary ? compactionSummarySchema : agentTurnSchema
    ).parse(request.value);
    result = { ok: true, sameOriginal: value === request.value, value };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const wire = JSON.parse(JSON.stringify(error));
    result = {
      ok: false,
      name: error.name,
      message: error.message,
      liveDescription: description(error),
      wire,
      decodedKind: "plain",
      decodedDescription: description(wire),
    };
  }
}
console.log(JSON.stringify({ id: request.id, result }));
