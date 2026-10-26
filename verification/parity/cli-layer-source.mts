import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { z } from "zod";

const request = z
  .object({
    ioTrace: z.string(),
    fixture: z.string(),
    removeMarkerAfterFirstFound: z.boolean().optional(),
  })
  .parse(
    JSON.parse(
      fs.readFileSync(process.env.DEMLIK_FRONTDOOR_REQUEST ?? "", "utf8"),
    ),
  );
const append = fs.appendFileSync;
const trace = (value: unknown) =>
  append(request.ioTrace, `${JSON.stringify(value)}\n`);
const inFixture = (value: unknown): value is string =>
  typeof value === "string" &&
  path.resolve(value).startsWith(`${request.fixture}/`);
function observedFile<
  T extends typeof fs.readFileSync | typeof fs.writeFileSync,
>(name: string, original: T): T {
  return new Proxy(original, {
    apply(target, receiver, args) {
      const file = args[0];
      if (inFixture(file))
        trace({ op: name, file, absolute: path.resolve(file) });
      try {
        const result = Reflect.apply(target, receiver, args);
        if (inFixture(file))
          trace({ op: `${name}-return`, file, absolute: path.resolve(file) });
        return result;
      } catch (error) {
        if (inFixture(file)) trace({ op: `${name}-throw`, file });
        throw error;
      }
    },
  });
}
fs.readFileSync = observedFile("readFileSync", fs.readFileSync);
fs.writeFileSync = observedFile("writeFileSync", fs.writeFileSync);
let removed = false;
fs.existsSync = new Proxy(fs.existsSync, {
  apply(target, receiver, args) {
    const value = Reflect.apply(target, receiver, args);
    if (
      inFixture(args[0]) &&
      path.basename(args[0]) === "pnpm-workspace.yaml"
    ) {
      trace({ op: "workspace-marker", file: args[0], exists: value });
      if (value && request.removeMarkerAfterFirstFound && !removed) {
        removed = true;
        fs.unlinkSync(args[0]);
        trace({ op: "controlled-marker-removal", file: args[0] });
      }
    }
    return value;
  },
});
function observedProcess<
  K extends
    | "spawn"
    | "spawnSync"
    | "execFile"
    | "execFileSync"
    | "execSync"
    | "fork",
>(name: K) {
  childProcess[name] = new Proxy(childProcess[name], {
    apply(target, receiver, args) {
      trace({ op: "process", method: name, args });
      return Reflect.apply(target, receiver, args);
    },
  });
}
for (const name of [
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
] as const)
  observedProcess(name);
function observedStream(name: string, stream: NodeJS.WriteStream) {
  stream.write = new Proxy(stream.write, {
    apply(target, receiver, args) {
      trace({
        op: "stdio-write",
        stream: name,
        payload: String(args[0]),
        exitCode: process.exitCode,
      });
      return Reflect.apply(target, receiver, args);
    },
  });
}
observedStream("stdout", process.stdout);
observedStream("stderr", process.stderr);
process.on("uncaughtExceptionMonitor", (error: NodeJS.ErrnoException) =>
  trace({
    op: "uncaught",
    name: error.name,
    code: error.code,
    exitCode: process.exitCode,
  }),
);
process.on("exit", (code) =>
  trace({ op: "exit", code, exitCode: process.exitCode }),
);
syncBuiltinESMExports();
await import("./cli-frontdoor-source.mjs");
