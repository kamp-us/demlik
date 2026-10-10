import { describe, expect, it } from "vitest";
import { tidyLines, withoutComments } from "./text.js";

// A template literal type's substitution, spelled without a template placeholder in this file.
const hole = (inner: string): string => `$${"{"}${inner}}`;

describe("withoutComments", () => {
  it("drops line and block comments and keeps everything else as written", () => {
    const text = [
      "export interface Shape {",
      "    /** The side. */",
      "    readonly side: number; // trailing",
      "    readonly /* inline */ corner: Corner;",
      "}",
    ].join("\n");
    expect(tidyLines(withoutComments(text))).toBe(
      [
        "export interface Shape {",
        "    readonly side: number;",
        "    readonly  corner: Corner;",
        "}",
      ].join("\n"),
    );
  });

  it("keeps comment-like text inside strings and template literal types", () => {
    const url = `type Url = \`https://${hole("Host")}/${hole('"/* x */"')}\`;`;
    const text = `${url} // gone\ntype S = "// kept";`;
    expect(withoutComments(text)).toBe(`${url} \ntype S = "// kept";`);
  });

  it("reads braces inside a template literal type's substitution", () => {
    const type = `type T = \`a${hole('{ b: 1 }["b"]')}c\``;
    expect(withoutComments(`${type} /* gone */;`)).toBe(`${type} ;`);
  });
});
