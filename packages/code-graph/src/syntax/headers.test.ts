import { describe, expect, it } from "vitest";
import { discoverFunctions } from "../extract/functions.js";
import type { FunctionHeader } from "../schema.js";
import { sourceUnit } from "../test-helpers/source-unit.js";
import { functionHeader } from "./headers.js";

function headers(source: string): Map<string, FunctionHeader & { startLine: number }> {
  const { functions } = discoverFunctions([sourceUnit(source)]);
  return new Map(
    functions.map((f) => [
      f.id,
      { ...functionHeader(f.unit.syntax, f.node), startLine: f.startLine },
    ]),
  );
}

function header(source: string, id: string): FunctionHeader & { startLine: number } {
  const found = headers(source).get(`fixture.ts:${id}`);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
}

describe("function headers (SPEC §6 A5)", () => {
  it("a function declaration's header runs from `export` to its return type", () => {
    const h = header("export function f<T>(a: T, b = 1): T {\n  return a;\n}\n", "f");
    expect(h).toEqual({
      text: "export function f<T>(a: T, b = 1): T",
      overloads: [],
      startLine: 1,
    });
  });

  it("a default-export function starts at `export default`", () => {
    expect(header("export default function (x: number) { return x; }\n", "default").text).toBe(
      "export default function (x: number)",
    );
  });

  it("a comment on the line above is not part of the header", () => {
    const h = header("/** Doc. */\n// note\nasync function g(): Promise<void> {}\n", "g");
    expect(h).toEqual({ text: "async function g(): Promise<void>", overloads: [], startLine: 3 });
  });

  it("a comment between the header and the body is not part of the header", () => {
    expect(header("function g(a: number) /* why */ {}\n", "g").text).toBe("function g(a: number)");
  });

  it("an arrow with an expression body ends on its `=>`", () => {
    expect(
      header("export const add = (a: number, b: number): number => a + b;\n", "add").text,
    ).toBe("(a: number, b: number): number =>");
  });

  it("an arrow with a block body ends on its `=>`", () => {
    expect(header("const run = async <T,>(x: T) => {\n  await x;\n};\n", "run").text).toBe(
      "async <T,>(x: T) =>",
    );
  });

  it("an arrow whose body is a parenthesized object ends on its `=>`", () => {
    expect(header("const make = () => ({ a: 1 });\n", "make").text).toBe("() =>");
  });

  it("a function expression's header starts at `function`", () => {
    expect(header("const h = function named(a: string): void {};\n", "named").text).toBe(
      "function named(a: string): void",
    );
  });

  it("class members keep their modifiers: method, constructor, getter, setter", () => {
    const source = [
      "class C {",
      "  constructor(private readonly x: number) {}",
      "  static async load(id: string): Promise<C> { return new C(1); }",
      "  get value(): number { return this.x; }",
      "  set value(v: number) {}",
      "}",
      "",
    ].join("\n");
    const all = headers(source);
    expect(all.get("fixture.ts:constructor")?.text).toBe("constructor(private readonly x: number)");
    expect(all.get("fixture.ts:load")?.text).toBe("static async load(id: string): Promise<C>");
    expect(all.get("fixture.ts:value#0")?.text).toBe("get value(): number");
    expect(all.get("fixture.ts:value#1")?.text).toBe("set value(v: number)");
  });

  it("an object-literal method's header is its key and parameters", () => {
    expect(
      header("const o = {\n  replay(opts) {\n    return opts;\n  },\n};\n", "replay").text,
    ).toBe("replay(opts)");
  });

  it("lists a function's overloads in source order, each from its own start line, without the comments between them", () => {
    const source = [
      "// first",
      "export function pick(a: string): string;",
      "/** Second. */",
      "export function pick(a: number): number;",
      "// Implementation signature",
      "export function pick(a: string | number): string | number {",
      "  return a;",
      "}",
      "",
    ].join("\n");
    const h = header(source, "pick");
    expect(h.text).toBe("export function pick(a: string | number): string | number");
    expect(h.startLine).toBe(6);
    expect(h.overloads).toEqual([
      { startLine: 2, text: "export function pick(a: string): string" },
      { startLine: 4, text: "export function pick(a: number): number" },
    ]);
  });

  it("lists a class method's overloads and leaves a same-named static method's out", () => {
    const source = [
      "class Q {",
      "  static get(): Q { return new Q(); }",
      "  get(key: string): string;",
      "  // between",
      "  get(key: number): number;",
      "  get(key: string | number): string | number {",
      "    return key;",
      "  }",
      "}",
      "",
    ].join("\n");
    const instance = headers(source).get("fixture.ts:get#1");
    expect(instance?.text).toBe("get(key: string | number): string | number");
    expect(instance?.overloads).toEqual([
      { startLine: 3, text: "get(key: string): string" },
      { startLine: 5, text: "get(key: number): number" },
    ]);
    expect(headers(source).get("fixture.ts:get#0")?.overloads).toEqual([]);
  });

  it("lists a constructor's overloads", () => {
    const source = [
      "class K {",
      "  constructor(a: string);",
      "  constructor(a: string | number) {}",
      "}",
      "",
    ].join("\n");
    const implementation = [...headers(source).values()].find((h) => h.startLine === 3);
    expect(implementation?.overloads).toEqual([{ startLine: 2, text: "constructor(a: string)" }]);
  });

  it("stops at the first signature that is not an overload of the implementation", () => {
    const source = [
      "function other(): void;",
      "function f(a: string): void;",
      "function f(a: string) {}",
      "function other() {}",
      "",
    ].join("\n");
    expect(header(source, "f").overloads).toEqual([
      { startLine: 2, text: "function f(a: string): void" },
    ]);
  });

  it("a node with no body runs to its end, less its closing `;`", () => {
    expect(header("interface I {\n  get size(): number;\n}\n", "size").text).toBe(
      "get size(): number",
    );
  });
});
