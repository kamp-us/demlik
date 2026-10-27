import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Cause, Effect, Exit, Fiber, Stream } from "effect";

const original = { kind: "cleanup", opaque: { value: 73 } };
let entered!: () => void;
const registered = new Promise<void>((resolve) => {
  entered = resolve;
});
let finalizerExit: unknown;
const stream = Stream.callback<never>(() =>
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        throw original;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            finalizerExit = {
              success: Exit.isSuccess(exit),
              sameOriginal:
                Exit.isFailure(exit) && Cause.squash(exit.cause) === original,
            };
          }),
        ),
      ),
    );
    entered();
  }),
);
const fiber = Effect.runFork(Stream.runDrain(stream));
await registered;
const interrupted = await Effect.runPromise(Fiber.interrupt(fiber));
const completed = await Effect.runPromise(Fiber.await(fiber));
assert.equal(interrupted, undefined);
assert.equal(Exit.isFailure(completed), true);
assert.deepEqual(finalizerExit, { success: false, sameOriginal: true });
assert.ok(
  Exit.isFailure(completed) && Cause.squash(completed.cause) === original,
);
const require = createRequire(import.meta.url);
const packageDirectory = path.dirname(require.resolve("effect/package.json"));
const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const sources = ["src/Fiber.ts", "src/internal/effect.ts"].map((file) => ({
  file,
  sha256: hash(readFileSync(path.join(packageDirectory, file))),
}));
const report = {
  node: process.version,
  v8: process.versions.v8,
  effect: JSON.parse(
    readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
  ).version,
  interruptResolvedUndefined: interrupted === undefined,
  completedExit: Exit.isFailure(completed) ? "failure" : "success",
  sameOriginal:
    Exit.isFailure(completed) && Cause.squash(completed.cause) === original,
  finalizerExit,
  actualExit: completed,
  sources,
  sourceRunner:
    "packages/tea/src/effect/run.ts: runner returns Effect.runPromise(Fiber.interrupt(fiber)); the Effect dependency uses asVoid(fiberAwait(self))",
};
writeFileSync(
  process.argv[2] ??
    "target/parity/subscription-conformance/effect-interrupt-source.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    interruptResolvedUndefined: report.interruptResolvedUndefined,
    completedExit: report.completedExit,
    sameOriginal: report.sameOriginal,
  }),
);
