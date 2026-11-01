import { realpathSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineMachine, refuse } from "../../index";
import { fileStore } from "../../node";
import { run } from "../../promise";
import { tool } from "../tool";

const Identifier = z.string().regex(/^[a-z0-9-]+$/);
const Input = z.object({ operationId: Identifier, text: z.string() });
const Intent = z.object({ callId: Identifier, args: Input });
const Result = z.object({ saved: z.literal(true) });
const Failure = z
  .object({ _tag: z.enum(["key_conflict", "thrown", "malformed_result"]) })
  .catchall(z.unknown());

export const Checkpoint = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Pending"), intent: Intent }),
  z.object({ type: z.literal("Settled"), intent: Intent, result: Result }),
  z.object({ type: z.literal("Failed"), intent: Intent, failure: Failure }),
]);

export const Point = z.enum([
  "before_execution",
  "after_acceptance",
  "before_settlement",
  "done",
]);
export const Handshake = z.object({ point: Point });

const Config = z.object({
  directory: z.string().min(1),
  kind: z.enum(["append", "keyed"]),
  cut: z.enum([
    "before_execution",
    "after_acceptance",
    "before_settlement",
    "finish",
  ]),
  intent: Intent,
});
type Context = z.infer<typeof Config>;
type State = z.infer<typeof Checkpoint>;

async function announce(point: z.infer<typeof Point>): Promise<void> {
  if (process.send === undefined) throw new Error("fixture requires IPC");
  await new Promise<void>((resolve, reject) => {
    process.send?.({ point }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function pause(ctx: Context, point: z.infer<typeof Point>) {
  if (ctx.cut !== point) return;
  await announce(point);
  await new Promise<never>(() => {});
}

// The keyed receiver stores the operation itself, not a sender-side marker.
const note = tool(
  "note",
  {
    description: "Save a note to the controlled local receiver.",
    input: Input,
    ok: Result,
    err: ["key_conflict"],
  },
  async (args, ctx: Context, { ok, fail }) => {
    await pause(ctx, "before_execution");
    if (ctx.kind === "append") {
      await appendFile(join(ctx.directory, "notes.txt"), `${args.text}\n`);
    } else {
      const path = join(ctx.directory, `${args.operationId}.receipt.json`);
      try {
        await writeFile(path, JSON.stringify(args), { flag: "wx" });
      } catch (error) {
        if (!z.object({ code: z.literal("EEXIST") }).safeParse(error).success) {
          throw error;
        }
        const accepted = Input.parse(JSON.parse(await readFile(path, "utf8")));
        if (
          accepted.text !== args.text ||
          accepted.operationId !== args.operationId
        ) {
          return fail({ _tag: "key_conflict", operationId: args.operationId });
        }
      }
    }
    await pause(ctx, "after_acceptance");
    return ok({ saved: true });
  },
);

type Msg = { readonly type: "HostBooted" };

async function main(ctx: Context) {
  process.channel?.ref();
  const machine = defineMachine({
    types: {
      model: {} as State,
      msg: {} as Msg,
      ctx: {} as Context,
    },
    cmds: [note],
    init: (loaded) => [loaded ?? { type: "Pending", intent: ctx.intent }, []],
    update: {
      HostBooted: (s) =>
        s.type === "Pending" ? [s, [note(s.intent)]] : [s, []],
      note_ok: (s, msg) =>
        s.type === "Pending" && s.intent.callId === msg.cmd.callId
          ? [{ type: "Settled", intent: s.intent, result: msg.value }, []]
          : [s, []],
      note_err: (s, msg) =>
        s.type === "Pending" && s.intent.callId === msg.cmd.callId
          ? [{ type: "Failed", intent: s.intent, failure: msg.error }, []]
          : [s, []],
    },
  });
  const backing = fileStore<State>(
    join(ctx.directory, `${ctx.intent.callId}.state.json`),
    (raw) => {
      if (raw === null) return null;
      const parsed = Checkpoint.safeParse(raw);
      return parsed.success
        ? parsed.data
        : refuse("invalid recovery checkpoint");
    },
  );
  const handle = run(machine, {
    ctx,
    clock: () => 1,
    store: {
      ...backing,
      async save(s) {
        if (s.type !== "Pending") await pause(ctx, "before_settlement");
        await backing.save(s);
      },
    },
    interpret: {
      note: async (cmd, handlerCtx) => {
        await appendFile(join(ctx.directory, "calls.log"), `${cmd.callId}\n`);
        return note.interpret(cmd, handlerCtx);
      },
    },
    terminal: (s) => s.type !== "Pending",
  });
  const booted = await handle.ready;
  await booted.dispatch({ type: "HostBooted" });
  await booted.done();
  await booted.stop();
  await announce("done");
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const ctx = Config.parse({
      directory: process.argv[2],
      kind: process.argv[3],
      cut: process.argv[4],
      intent: {
        callId: process.argv[5],
        args: { operationId: process.argv[6], text: process.argv[7] },
      },
    });
    await main(ctx);
  } finally {
    process.disconnect?.();
  }
}
