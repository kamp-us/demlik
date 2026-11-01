import { describe, expect, it } from "vitest";
import { sourceUnit } from "../test-helpers/source-unit.js";

const LINE_SEPARATOR = String.fromCharCode(0x2028);

const syntaxOf = (text: string) => sourceUnit(text).syntax;

describe("lineCount counts the lines a person counts", () => {
  it.each([
    ["an empty file", "", 0],
    ["one line and its newline", "a\n", 1],
    ["one line with no newline", "a", 1],
    ["two lines ending in LF", "a\nb\n", 2],
    ["two lines with no final newline", "a\nb", 2],
    ["two lines ending in CRLF", "a\r\nb\r\n", 2],
    ["two lines ending in CR", "a\rb\r", 2],
    ["two lines ending in a line separator", `a${LINE_SEPARATOR}b${LINE_SEPARATOR}`, 2],
    ["only a newline", "\n", 1],
    ["blank lines at the end", "a\n\n\n", 3],
    ["blank lines at the end with CRLF", "a\r\n\r\n\r\n", 3],
  ])("%s", (_name, text, count) => {
    expect(syntaxOf(text).lineCount()).toBe(count);
  });
});

describe("lineOf answers for every offset, the one past a final newline included", () => {
  it.each([
    ["", [1]],
    ["a\nb\n", [1, 1, 2, 2, 3]],
    ["a\nb", [1, 1, 2, 2]],
    ["a\r\nb\r\n", [1, 1, 1, 2, 2, 2, 3]],
    ["a\n\n\n", [1, 1, 2, 3, 4]],
  ])("%j", (text, lines) => {
    const syntax = syntaxOf(text);
    expect(Array.from({ length: text.length + 1 }, (_, at) => syntax.lineOf(at))).toEqual(lines);
  });

  it("keeps a finding's line in a file ending in a newline", () => {
    const { syntax } = sourceUnit("const a = 1;\n\nexport function f() {\n  return a;\n}\n");
    const node = syntax.program.body[1];
    if (node === undefined) throw new Error("the fixture has two statements");
    expect([syntax.startLine(node), syntax.endLine(node)]).toEqual([3, 5]);
  });
});
