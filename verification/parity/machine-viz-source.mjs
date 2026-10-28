import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  safeId,
  safeLabel,
  toMermaid,
} from "../../packages/tea/src/machine-viz/index.ts";

const cases = JSON.parse(
  fs.readFileSync(
    new URL("./machine-viz-cases.json.fixture", import.meta.url),
    "utf8",
  ),
);
const observe = (input) => {
  if (input.kind === "sanitize")
    return {
      output: input.texts.map((text) => ({
        id: safeId(text),
        label: safeLabel(text),
      })),
      calls: [],
    };
  const calls = [];
  const update = Object.fromEntries(
    input.rows.map(([state, row]) => [
      state,
      input.form === "reducer"
        ? () => {
            throw new Error("a reducer cell must not be executed");
          }
        : Object.fromEntries(
            row.map(([message, target]) => [
              message,
              (s, m) => {
                calls.push(["cell", state, message, s.type, m.type]);
                if (input.throwCell === `${state}.${message}`)
                  throw new Error("cell refused");
                return [{ type: target }, []];
              },
            ]),
          ),
    ]),
  );
  const machine = {
    __form: input.form,
    init: () => {
      calls.push(["init"]);
      if (input.throwInit) throw new Error("init refused");
      return [{ type: input.rows[0]?.[0] ?? "fresh" }, []];
    },
    update,
    subs: input.subs.map((sub, index) => ({
      type: sub.name,
      deps: (s) => {
        calls.push(["deps", index, s.type]);
        if (sub.throw) throw new Error("deps refused");
        return sub.active.includes(s.type) ? { active: true } : null;
      },
    })),
    interpret: new Proxy(
      {},
      {
        get() {
          throw new Error("interpret must not be read");
        },
      },
    ),
    subscribe: new Proxy(
      {},
      {
        get() {
          throw new Error("subscribe must not be read");
        },
      },
    ),
  };
  const opts = {
    samples: {
      states: Object.fromEntries(
        input.states.map(([key, type]) => [key, { type }]),
      ),
      msgs: Object.fromEntries(
        input.messages.map(([key, type]) => [key, { type }]),
      ),
    },
  };
  if (input.ctx) opts.samples.ctx = {};
  if (input.title !== undefined) opts.title = input.title;
  if (input.direction !== undefined) opts.direction = input.direction;
  try {
    return { output: toMermaid(machine, opts), calls };
  } catch (error) {
    return { error: error.message, calls };
  }
};
const report = {
  reference: "75de37ea01a81cd7949e6275b7ee9cfdeb4e312d",
  node: process.version,
  v8: process.versions.v8,
  cases: cases.map((input) => ({
    id: input.id,
    input,
    comparison: observe(input),
  })),
};
assert.equal(report.cases.length, 18);
const output = process.argv[2];
assert.ok(output);
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify({
    cases: report.cases.length,
    report: fileURLToPath(new URL(output, "file:///")),
    sha256: createHash("sha256").update(fs.readFileSync(output)).digest("hex"),
  }),
);
