/**
 * What an author reads when `Machine.make`'s `msg` declares a tag it refuses (#928).
 *
 * The `@ts-expect-error` rows in `machine.test-d.ts` prove each declaration is
 * refused, and say nothing of the words. Here the `desk` machine is compiled
 * the way a user compiles it, importing `@demlik/tea/effect`, and the
 * diagnostic on its `msg:` line is read: it names each colliding tag, or says
 * the tags must be literals. One compile is about a second, so each is its own
 * `it`, under a timeout past Vitest's 5 second default (#573).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cacheDir, programDiagnostics } from "../docs/in-memory-program";

const FILE = "desk.ts";
const MSG_UNION = "export const DeskMsg = Schema.Union([";
const MSG_LINE = "  msg: DeskMsg,";

const desk = readFileSync(
  new URL("./fixtures/schema-machine.ts", import.meta.url),
  "utf8",
).replace('from "../index"', 'from "@demlik/tea/effect"');

/** `text` with its one `anchor` replaced; an anchor the fixture lost is an error, not a no-op. */
function replaced(text: string, anchor: string, by: string): string {
  if (!text.includes(anchor)) throw new Error(`the fixture lost ${anchor}`);
  return text.replace(anchor, by);
}

/** The desk machine with `members` ahead of the three plain Msgs in `DeskMsg`. */
const withMembers = (...members: readonly string[]): string =>
  replaced(desk, MSG_UNION, `${MSG_UNION}\n${members.join("\n")}`);

/** The desk machine with the whole `DeskMsg` declaration replaced by `declaration`. */
function withDeskMsg(declaration: string): string {
  const start = desk.indexOf(MSG_UNION);
  const end = desk.indexOf("]);", start);
  if (start < 0 || end < 0) throw new Error("the fixture lost DeskMsg");
  return `${desk.slice(0, start)}${declaration}${desk.slice(end + "]);".length)}`;
}

const taggedLiteral = (tag: string): string =>
  `Schema.Struct({ type: Schema.Literal("${tag}") }),`;

const diagnosticsOf = (program: string): string[] =>
  programDiagnostics(
    join(cacheDir("tea-machine-msg-diagnostics"), "desk"),
    new Map([[FILE, program]]),
  );

/** The diagnostics reported on the line of `msg: DeskMsg`, which `program` carries. */
function onMsgLine(program: string): string {
  const line = program.slice(0, program.indexOf(MSG_LINE)).split("\n").length;
  return diagnosticsOf(program)
    .filter((diagnostic) => diagnostic.startsWith(`${FILE}:${line} `))
    .join("\n");
}

/** How the diagnostic spells a refused tag: the key it says is missing. */
const namesTag = (tag: string): string =>
  `msg tag \\"${tag}\\" is a settled Msg name of a listed Cmd`;

const MUST_BE_LITERAL = "every msg tag must be a literal";

const SETTLED_NAMES = [
  "LoadTickets_ok",
  "LoadTickets_err",
  "ReadTicket_ok",
  "ReadTicket_err",
  "CloseTicket_ok",
  "CloseTicket_err",
] as const;

describe(
  "Machine.make's msg line, as a user compiles it",
  {
    timeout: 120_000,
  },
  () => {
    it("is clean for the desk machine as written", () => {
      expect(diagnosticsOf(desk)).toEqual([]);
    });

    it.each(
      SETTLED_NAMES,
    )("names %s when a plain Msg is called that", (name) => {
      expect(onMsgLine(withMembers(taggedLiteral(name)))).toContain(
        namesTag(name),
      );
    });

    it("names every tag when three plain Msgs are named like answers", () => {
      const tags = ["LoadTickets_ok", "ReadTicket_err", "CloseTicket_ok"];

      const refusal = onMsgLine(withMembers(...tags.map(taggedLiteral)));

      for (const tag of tags) expect(refusal).toContain(namesTag(tag));
    });

    it.each([
      {
        shape: "DeskMsg replaced by one whose tag is Schema.String",
        program: withDeskMsg(
          "export const DeskMsg = Schema.Struct({ type: Schema.String });",
        ),
      },
      {
        shape: "a Schema.String tagged member beside the three desk Msgs",
        program: withMembers("Schema.Struct({ type: Schema.String }),"),
      },
      {
        shape: "a Schema.TemplateLiteral tag",
        program: withMembers(
          'Schema.Struct({ type: Schema.TemplateLiteral([Schema.String, "_ok"]) }),',
        ),
      },
    ])("says the tag must be a literal for $shape", ({ program }) => {
      expect(onMsgLine(program)).toContain(MUST_BE_LITERAL);
    });
  },
);
