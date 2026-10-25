import { createInterface } from "node:readline";
import { z } from "zod";
import { parseChangeset } from "../../packages/code-graph/src/api/ratchet/changesets.ts";

const request = z
  .object({
    id: z.string(),
    operation: z.literal("parse"),
    input: z.object({ text: z.string() }).strict(),
  })
  .strict();
for await (const line of createInterface({ input: process.stdin })) {
  const value = request.parse(JSON.parse(line));
  const parsed = parseChangeset(value.input.text);
  console.log(
    JSON.stringify({
      id: value.id,
      ok: true,
      output:
        parsed === null
          ? null
          : { bumps: [...parsed.bumps], body: parsed.body },
    }),
  );
}
