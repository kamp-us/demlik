import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ApiFlags, runApiFlags } from "../cli.js";
import {
  DOCS_MAP,
  DOCS_REPORT,
  DOCS_SHAPE,
  docsPackage,
  removePackage,
} from "./docs-package.fixture.js";

// What the command line accepts beside --api-docs (SPEC §13.10), run in process: each refusal is
// one message, exit 2 and no payload.
let root: string;
beforeEach(() => {
  root = docsPackage();
});
afterEach(() => removePackage(root));

type Outcome = { code: number | null; payload: string[]; messages: string[] };

async function run(flags: ApiFlags, extraGiven: string[] = []): Promise<Outcome> {
  const payload: string[] = [];
  const messages: string[] = [];
  const result = runApiFlags(flags, {
    rootAbsolute: root,
    given: [...Object.keys(flags), ...extraGiven],
    json: false,
    pretty: false,
    emit: (text) => payload.push(text),
    report: (message) => messages.push(message),
  });
  return { code: result === null ? null : await result, payload, messages };
}

function tempFile(name: string, text: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, text);
  return file;
}

describe("--api-docs on the command line", () => {
  it("prints the report in process as it does through the shell", async () => {
    const { code, payload, messages } = await run({ api: DOCS_MAP, apiDocs: DOCS_SHAPE });
    expect(payload.join("")).toBe(DOCS_REPORT);
    expect(messages).toEqual([]);
    expect(code).toBe(0);
  });

  it("needs --api", async () => {
    const { code, payload, messages } = await run({ apiDocs: DOCS_SHAPE });
    expect(code).toBe(2);
    expect(payload).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("--api-docs needs --api <map>");
  });

  it.each([
    ["--ci", { ci: true }, []],
    ["--api-base", { apiBase: "main" }, []],
    ["--api-policy", { apiBase: "main", apiPolicy: "policy.json" }, []],
    ["--accept-api", { acceptApi: true, reason: "why" }, []],
    ["--reason", { reason: "why" }, []],
    ["--smells", {}, ["smells"]],
    ["--unreachable", {}, ["unreachable"]],
  ])("refuses %s beside it and names it", async (flag, extra, given) => {
    const { code, payload, messages } = await run(
      { api: DOCS_MAP, apiDocs: DOCS_SHAPE, ...extra },
      given,
    );
    expect(code).toBe(2);
    expect(payload).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(flag);
    expect(messages[0]).toContain("--api-docs");
  });

  it.each([
    ["a shape file that is not there", "missing.json", null],
    ["a shape file that is not JSON", "bad.json", "{ not json"],
    [
      "a shape the schema refuses",
      "unknown.json",
      '{ "export": { "block": "required", "description": "required" }, "sections": [] }',
    ],
    [
      "a shape that asks for nothing",
      "nothing.json",
      '{ "export": { "block": "optional", "description": "optional" } }',
    ],
  ])("refuses %s before it opens the package", async (_, name, text) => {
    // No tsconfig: a run that got as far as the package would refuse for that instead.
    fs.rmSync(path.join(root, "tsconfig.json"));
    const shape = text === null ? path.join(root, name) : tempFile(name, text);
    const { code, payload, messages } = await run({ api: DOCS_MAP, apiDocs: shape });
    expect(code).toBe(2);
    expect(payload).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("API docs shape");
    expect(messages[0]).not.toContain("tsconfig");
  });

  it("refuses an invalid map and a package with no tsconfig, each with one line", async () => {
    const map = tempFile("map.json", '{ ".": { "entry": "src/nowhere.ts" } }');
    expect((await run({ api: map, apiDocs: DOCS_SHAPE })).code).toBe(2);
    fs.rmSync(path.join(root, "tsconfig.json"));
    const { code, messages } = await run({ api: DOCS_MAP, apiDocs: DOCS_SHAPE });
    expect(code).toBe(2);
    expect(messages).toHaveLength(1);
  });
});
