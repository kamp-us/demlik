import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const repository = fileURLToPath(new URL("../..", import.meta.url));
const request = z
  .object({
    trace: z.string(),
    input: z.record(z.string(), z.unknown()),
    rawArgv: z.boolean().optional(),
  })
  .parse(
    JSON.parse(
      fs.readFileSync(process.env.DEMLIK_FRONTDOOR_REQUEST ?? "", "utf8"),
    ),
  );
const labels = new WeakMap<object, string>();
const trace = (value: unknown) =>
  fs.appendFileSync(request.trace, `${JSON.stringify(value)}\n`);
for (const [name, stream] of [
  ["stdout", process.stdout],
  ["stderr", process.stderr],
] as const) {
  const original = stream.emit.bind(stream);
  stream.emit = (event: string | symbol, ...args: unknown[]) => {
    if (event === "error" && typeof args[0] === "object" && args[0] !== null)
      labels.set(args[0], name);
    return original(event, ...args);
  };
}
process.on("uncaughtExceptionMonitor", (error: NodeJS.ErrnoException) =>
  trace({
    event: "uncaught",
    name: error.name,
    message: error.message,
    code: error.code,
    path: error.path,
    syscall: error.syscall,
    stream: labels.get(error),
    exitCode: process.exitCode,
  }),
);
process.on("exit", (code) =>
  trace({ event: "exit", code, exitCode: process.exitCode }),
);
const input = request.input;
if (input.initial !== undefined)
  process.exitCode = z.number().int().parse(input.initial);
if (input.action === "frontdoor") {
  if (request.rawArgv) {
    const require = createRequire(
      path.join(repository, "packages/code-graph/package.json"),
    );
    const { Command } =
      require("commander") as typeof import("../../packages/code-graph/node_modules/commander/typings/index.js");
    const original = Command.prototype.parse;
    Command.prototype.parse = function () {
      return original.call(this, z.array(z.string()).parse(input.argv), {
        from: "user",
      });
    };
  }
  await import("../../packages/code-graph/src/index.js");
} else {
  const { cleanExit, outputTo, exitWith } = await import(
    "../../packages/code-graph/src/cli.js"
  );
  try {
    if (input.action === "clean") cleanExit(z.string().parse(input.payload));
    else if (input.action === "out")
      outputTo(
        input.destination === undefined || input.destination === null
          ? undefined
          : z.string().parse(input.destination),
      )(z.string().parse(input.payload));
    else if (input.action === "exit") {
      const special = {
        NaN: Number.NaN,
        Infinity: Number.POSITIVE_INFINITY,
        "-Infinity": Number.NEGATIVE_INFINITY,
        "-0": -0,
      };
      exitWith(
        typeof input.code === "string"
          ? special[
              z.enum(["NaN", "Infinity", "-Infinity", "-0"]).parse(input.code)
            ]
          : z.number().parse(input.code),
      );
    } else throw new Error("unknown source probe action");
    trace({ event: "returned", exitCode: process.exitCode });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const failure = error as NodeJS.ErrnoException;
    trace({
      event: "thrown",
      name: failure.name,
      message: failure.message,
      code: failure.code,
      path: failure.path,
      syscall: failure.syscall,
      exitCode: process.exitCode,
    });
    throw error;
  }
}
