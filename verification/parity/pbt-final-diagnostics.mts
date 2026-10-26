import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect, parseArgs } from "node:util";
import type * as FastCheck from "../../packages/tea/node_modules/fast-check";
import { defineMachine } from "../../packages/tea/src/index.js";
import {
  propertyTerminates,
  propertyTrace,
} from "../../packages/tea/src/pbt/index.js";
import { pbtFinalCases } from "./pbt-final-cases.mts";

const require = createRequire(
  new URL("../../packages/tea/package.json", import.meta.url),
);
const fc: typeof FastCheck = require("fast-check");
export function pbtFinalDiagnostics({
  binary,
  reportFile = "target/parity/pbt-final-diagnostics.json",
}: {
  binary: string;
  reportFile?: string;
}) {
  const observations = [];
  for (const mode of ["terminates", "trace"] as const)
    for (const good of [true, false]) {
      let serializations = 0,
        predicates = 0;
      const cause = { type: "json-trap", capability: () => 17 };
      const state = {
        type: "active",
        toJSON() {
          serializations++;
          throw cause;
        },
      };
      const machine = defineMachine({
        init: () => [state, []],
        update: {},
        subs: [],
      });
      let status = "ok",
        diagnostics: unknown = null;
      try {
        Reflect.apply(
          mode === "terminates" ? propertyTerminates : propertyTrace,
          undefined,
          [
            machine,
            undefined,
            fc.constant([]),
            () => {
              predicates++;
              return good;
            },
            { numRuns: 1, seed: 42 },
          ],
        );
      } catch (error) {
        status = "error";
        diagnostics = {
          inspect: inspect(error, {
            depth: 8,
            showHidden: true,
            colors: false,
          }),
          message: error instanceof Error ? error.message : null,
          isOriginal: error === cause,
        };
      }
      assert.equal(predicates, 1);
      assert.equal(serializations, good ? 0 : 1);
      assert.equal(status, good ? "ok" : "error");
      const nativeCase = pbtFinalCases().counter.find(
        (c) => c.id === `pbt-${mode}.loaded-empty-${good ? "true" : "false"}`,
      );
      assert(nativeCase);
      const native = spawnSync(binary, [], {
        input: `${JSON.stringify(nativeCase)}\n`,
        encoding: "utf8",
      });
      assert.equal(native.status, 0, native.stderr);
      observations.push({
        id: `pbt-final-open.${mode}.toJSON-${good}`,
        source: { status, serializations, predicates, diagnostics },
        native: JSON.parse(native.stdout),
        strictlyCompared: false,
        qualification:
          "The Source model has an actual toJSON trap. Native typed models have no universal serializer/toJSON contract; the native row separately observes typed true/false without serializing its opaque state. This is an OPEN capability gap, not an equal-input strict comparison.",
      });
    }
  const report = {
    status: "OPEN",
    semanticCases: 0,
    observations,
    binary: {
      path: resolve(binary),
      sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    },
  };
  mkdirSync(dirname(resolve(reportFile)), { recursive: true });
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: { "native-bin": { type: "string" }, report: { type: "string" } },
    strict: true,
  });
  assert(values["native-bin"]);
  const r = pbtFinalDiagnostics({
    binary: values["native-bin"],
    reportFile: values.report,
  });
  console.log(
    JSON.stringify({
      status: r.status,
      observations: r.observations.length,
      semanticCases: 0,
    }),
  );
}
