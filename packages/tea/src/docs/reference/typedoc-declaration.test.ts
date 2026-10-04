/**
 * Unit tests for the declaration printer. The drift gate cannot own these: it
 * compares committed output to freshly generated output, so a printer that
 * drops parentheses or an optional mark changes both sides and passes. These
 * assert the printed TypeScript against hand-built type nodes instead.
 */

import { describe, expect, it } from "vitest";
import { printDeclaration, printType } from "./typedoc-declaration";

const KIND_FUNCTION = 64;
const KIND_INTERFACE = 256;
const KIND_PROPERTY = 1024;
const KIND_TYPE_ALIAS = 2097152;
const KIND_REFERENCE = 4194304;

const intrinsic = (name: string) => ({ type: "intrinsic", name });
const ref = (name: string, ...typeArguments: unknown[]) => ({
  type: "reference",
  name,
  typeArguments,
});
const param = (name: string, type: unknown, flags = {}) => ({
  name,
  type,
  flags,
});
/** A function type: a type literal that is one call signature. */
const fn = (parameters: unknown[], returns: unknown) => ({
  type: "reflection",
  declaration: { signatures: [{ parameters, type: returns }] },
});

describe("printType — where precedence needs parentheses", () => {
  it.each([
    [
      "an array of a union",
      {
        type: "array",
        elementType: {
          type: "union",
          types: [intrinsic("string"), intrinsic("number")],
        },
      },
      "(string | number)[]",
    ],
    [
      "a function type inside a union",
      {
        type: "union",
        types: [fn([], intrinsic("void")), intrinsic("undefined")],
      },
      "(() => void) | undefined",
    ],
    [
      "a union inside an intersection",
      {
        type: "intersection",
        types: [ref("A"), { type: "union", types: [ref("B"), ref("C")] }],
      },
      "A & (B | C)",
    ],
    [
      "a readonly array of a plain reference",
      {
        type: "typeOperator",
        operator: "readonly",
        target: { type: "array", elementType: ref("Cmd") },
      },
      "readonly Cmd[]",
    ],
  ])("%s", (_case, type, printed) => {
    expect(printType(type)).toBe(printed);
  });

  it("refuses a node kind it has no printer for", () => {
    expect(() => printType({ type: "somethingNew" })).toThrowError(
      /no printer for a 'somethingNew' node/,
    );
  });
});

describe("printDeclaration", () => {
  it("prints a function's parameters and return type, one line per overload", () => {
    const printed = printDeclaration("store", {
      kind: KIND_FUNCTION,
      signatures: [
        {
          typeParameters: [{ name: "S" }],
          parameters: [
            param("path", intrinsic("string")),
            param("parse", fn([param("raw", intrinsic("unknown"))], ref("S"))),
          ],
          type: ref("Store", ref("S")),
        },
        {
          parameters: [
            param("options", ref("Options"), { isOptional: true }),
            param(
              "rest",
              { type: "array", elementType: intrinsic("string") },
              { isRest: true },
            ),
          ],
          type: intrinsic("void"),
        },
      ],
    });
    expect(printed).toBe(
      [
        "function store<S>(path: string, parse: (raw: unknown) => S): Store<S>",
        "function store(options?: Options, ...rest: string[]): void",
      ].join("\n"),
    );
  });

  it("refuses a function with no call signature", () => {
    expect(() =>
      printDeclaration("store", { kind: KIND_FUNCTION, signatures: [] }),
    ).toThrowError(/function 'store' has no call signature/);
  });

  it("prints an interface's own members and leaves inherited ones to `extends`", () => {
    const printed = printDeclaration("Options", {
      kind: KIND_INTERFACE,
      extendedTypes: [ref("Base")],
      children: [
        {
          name: "fenced",
          kind: KIND_PROPERTY,
          flags: { isOptional: true, isReadonly: true },
          type: { type: "literal", value: true },
        },
        {
          name: "inherited",
          kind: KIND_PROPERTY,
          type: intrinsic("string"),
          inheritedFrom: ref("Base.inherited"),
        },
      ],
    });
    expect(printed).toBe(
      "interface Options extends Base {\n  readonly fenced?: true;\n}",
    );
  });

  it("prints a member's TSDoc above it, read off the call signature for a function-typed one", () => {
    const comment = (...lines: string[]) => ({
      summary: [{ kind: "text", text: lines.join("\n") }],
    });
    const printed = printDeclaration("Options", {
      kind: KIND_INTERFACE,
      children: [
        {
          name: "maxTurns",
          kind: KIND_PROPERTY,
          flags: { isOptional: true },
          type: intrinsic("number"),
          comment: comment("Model round-trips the run may take."),
        },
        {
          name: "stopWhen",
          kind: KIND_PROPERTY,
          type: {
            type: "reflection",
            declaration: {
              signatures: [
                {
                  parameters: [],
                  type: intrinsic("boolean"),
                  comment: comment("Your own condition.", "", "Must be pure."),
                },
              ],
            },
          },
        },
        { name: "bare", kind: KIND_PROPERTY, type: intrinsic("string") },
      ],
    });
    expect(printed).toBe(
      [
        "interface Options {",
        "  /** Model round-trips the run may take. */",
        "  maxTurns?: number;",
        "  /**",
        "   * Your own condition.",
        "   *",
        "   * Must be pure.",
        "   */",
        "  stopWhen: () => boolean;",
        "  bare: string;",
        "}",
      ].join("\n"),
    );
  });

  it("prints a type alias under the name the module exports it as", () => {
    expect(
      printDeclaration("Exported", {
        name: "Declared",
        kind: KIND_TYPE_ALIAS,
        typeParameters: [{ name: "M", type: ref("Msg") }],
        type: { type: "array", elementType: ref("M") },
      }),
    ).toBe("type Exported<M extends Msg> = M[]");
  });

  it("has nothing to print for a re-export it could not resolve", () => {
    expect(printDeclaration("gone", { kind: KIND_REFERENCE })).toBeNull();
  });
});
