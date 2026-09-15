/**
 * Unit tests for the typedoc boundary parse — specifically the signature-comment
 * fallback, which is the thing the end-to-end drift gate structurally cannot
 * catch. The gate compares committed output to freshly generated output, so a
 * regression that blanks every function summary blanks BOTH sides and passes.
 * These assert the parse against a hand-built reflection instead.
 */

import { describe, expect, it } from "vitest";
import { firstSentence, parseTypedocModel } from "./typedoc-model";

const KIND_MODULE = 2;
const KIND_FUNCTION = 64;
const KIND_REFERENCE = 4194304;

/** A typedoc `comment` whose summary flattens to `text`. */
const comment = (text: string) => ({ summary: [{ kind: "text", text }] });

/** One module holding one symbol — the smallest tree `parseTypedocModel` reads. */
const projectWith = (symbol: Record<string, unknown>) => ({
  children: [
    {
      name: "index",
      kind: KIND_MODULE,
      comment: comment("The module."),
      children: [{ name: "doThing", kind: KIND_FUNCTION, ...symbol }],
    },
  ],
});

const summaryOf = (symbol: Record<string, unknown>) =>
  parseTypedocModel(projectWith(symbol))[0]?.symbols[0]?.summary;

describe("parseTypedocModel — the symbol comment fallback", () => {
  it("reads the first signature's comment when the declaration has none", () => {
    expect(
      summaryOf({
        signatures: [{ comment: comment("Run the thing. Then run it again.") }],
      }),
    ).toBe("Run the thing.");
  });

  it("prefers the declaration's own comment over the signature's", () => {
    expect(
      summaryOf({
        comment: comment("The declaration wins."),
        signatures: [{ comment: comment("The signature loses.") }],
      }),
    ).toBe("The declaration wins.");
  });

  it("is empty when neither the declaration nor a signature is documented", () => {
    expect(summaryOf({})).toBe("");
    expect(summaryOf({ signatures: [] })).toBe("");
    expect(summaryOf({ signatures: [{}] })).toBe("");
  });

  it("ignores every signature past the first", () => {
    expect(
      summaryOf({
        signatures: [
          { comment: comment("The first overload.") },
          { comment: comment("The second overload.") },
        ],
      }),
    ).toBe("The first overload.");
  });
});

/**
 * A project where `index` re-exports a symbol another module declares — what
 * typedoc emits for every entry point that re-exports another entry point's
 * symbol, and therefore what every door over `src/internal/` produces.
 */
const projectWithReference = (
  target: number,
  declaration?: Record<string, unknown>,
) => ({
  children: [
    {
      name: "index",
      kind: KIND_MODULE,
      comment: comment("The module."),
      children: [{ id: 1, name: "doThing", kind: KIND_REFERENCE, target }],
    },
    {
      name: "flow",
      kind: KIND_MODULE,
      comment: comment("The declaring module."),
      children: declaration ? [declaration] : [],
    },
  ],
});

describe("parseTypedocModel — re-exports", () => {
  const row = (project: unknown) => parseTypedocModel(project)[0]?.symbols[0];

  it("renders the target's kind and TSDoc under the re-exporting name", () => {
    expect(
      row(
        projectWithReference(2, {
          id: 2,
          name: "doThing",
          kind: KIND_FUNCTION,
          comment: comment("Do the thing. At length."),
        }),
      ),
    ).toEqual({
      name: "doThing",
      kindLabel: "Function",
      summary: "Do the thing.",
    });
  });

  it("follows a chain of re-exports to the declaration at its end", () => {
    const project = {
      children: [
        {
          name: "index",
          kind: KIND_MODULE,
          comment: comment("The module."),
          children: [
            { id: 1, name: "doThing", kind: KIND_REFERENCE, target: 2 },
          ],
        },
        {
          name: "flow",
          kind: KIND_MODULE,
          comment: comment("The middle."),
          children: [
            { id: 2, name: "doThing", kind: KIND_REFERENCE, target: 3 },
            {
              id: 3,
              name: "doThing",
              kind: KIND_FUNCTION,
              comment: comment("The declaration at the end."),
            },
          ],
        },
      ],
    };
    expect(row(project)?.summary).toBe("The declaration at the end.");
  });

  // Both arms of "unresolvable": a target outside the project, and a cycle.
  // Either must leave a thin row rather than throw or spin.
  it("falls back to the reference when its target is not in the project", () => {
    expect(row(projectWithReference(99))).toEqual({
      name: "doThing",
      kindLabel: "Reference",
      summary: "",
    });
  });

  it("terminates on a reference cycle", () => {
    const project = {
      children: [
        {
          name: "index",
          kind: KIND_MODULE,
          comment: comment("The module."),
          children: [
            { id: 1, name: "doThing", kind: KIND_REFERENCE, target: 2 },
          ],
        },
        {
          name: "flow",
          kind: KIND_MODULE,
          comment: comment("The other."),
          children: [
            { id: 2, name: "doThing", kind: KIND_REFERENCE, target: 1 },
          ],
        },
      ],
    };
    expect(row(project)?.kindLabel).toBe("Reference");
  });
});

describe("firstSentence", () => {
  it("cuts at the first terminator followed by whitespace or end of input", () => {
    expect(firstSentence("One. Two.")).toBe("One.");
    expect(firstSentence("Is it? Yes.")).toBe("Is it?");
    expect(firstSentence("Stop!")).toBe("Stop!");
  });

  it("does not cut at a period inside a token", () => {
    expect(firstSentence("Call `a.b()` first. Then stop.")).toBe(
      "Call `a.b()` first.",
    );
  });

  it("returns the whole blob, whitespace-collapsed, when it has no terminator", () => {
    expect(firstSentence("no\n  terminator here")).toBe("no terminator here");
  });

  it("is empty on empty or whitespace-only input", () => {
    expect(firstSentence("")).toBe("");
    expect(firstSentence("   \n  ")).toBe("");
  });
});
