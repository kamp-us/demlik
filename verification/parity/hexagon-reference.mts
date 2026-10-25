import { ApiInputError } from "../../packages/code-graph/src/api/map.js";
import { parseTypeScript } from "../../packages/code-graph/src/engine/oxc.js";
import { runHexagon } from "../../packages/code-graph/src/hexagon/cli.js";
import { readPorts } from "../../packages/code-graph/src/hexagon/ports.js";
import {
  type Hexagon,
  readHexagon,
} from "../../packages/code-graph/src/hexagon/read.js";
import { renderHexagon } from "../../packages/code-graph/src/hexagon/render.js";
import { SyntaxFile } from "../../packages/code-graph/src/syntax/file.js";

export type NumberInput = number | "NaN" | "Infinity" | "-Infinity" | "-0";
type CallbackMode = "ok" | "callback" | "input";
export type HexagonInput =
  | { action: "read"; root: string }
  | { action: "ports"; text: string | null }
  | {
      action: "render";
      report: Hexagon;
      json: boolean;
      pretty: boolean;
      line?: NumberInput;
    }
  | {
      action: "run";
      root: string;
      json: boolean;
      pretty: boolean;
      emitMode?: CallbackMode;
      reportMode?: CallbackMode;
      emitMessage?: string;
      reportMessage?: string;
    }
  | {
      action: "frontdoor";
      argv: string[];
      initial?: number;
      compiler?: string;
    };
export function numeric(value: NumberInput): number {
  if (typeof value === "number") return value;
  return {
    NaN: Number.NaN,
    Infinity: Number.POSITIVE_INFINITY,
    "-Infinity": Number.NEGATIVE_INFINITY,
    "-0": -0,
  }[value];
}
function exception(error: unknown) {
  if (!(error instanceof Error)) throw error;
  return { name: error.name, message: error.message };
}
export function hexagonReference(
  input: Exclude<HexagonInput, { action: "frontdoor" }>,
) {
  if (input.action === "run") {
    const events: { kind: "emit" | "report"; message: string }[] = [];
    const callback = (
      mode: CallbackMode | undefined,
      message: string,
      kind: "emit" | "report",
    ) => {
      if (mode === "callback") throw new Error(message, { cause: { kind } });
      if (mode === "input") throw new ApiInputError(message);
    };
    let thrown = null;
    try {
      runHexagon(input.root, {
        json: input.json,
        pretty: input.pretty,
        emit: (message) => {
          events.push({ kind: "emit", message });
          callback(input.emitMode, input.emitMessage ?? "emit error", "emit");
        },
        report: (message) => {
          events.push({ kind: "report", message });
          callback(
            input.reportMode,
            input.reportMessage ?? "report error",
            "report",
          );
        },
      });
    } catch (error) {
      thrown = exception(error);
    }
    return { events, thrown };
  }
  try {
    let value: unknown;
    if (input.action === "read") value = readHexagon(input.root);
    else if (input.action === "render") {
      if (input.line !== undefined) {
        const first = input.report.notRead[0];
        if (first === undefined)
          throw new Error("line override needs a notRead fact");
        first.line = numeric(input.line);
      }
      value = renderHexagon(input.report, input.json, input.pretty);
    } else {
      const parsed =
        input.text === null ? null : parseTypeScript("ports.ts", input.text);
      const syntax =
        parsed?.ok === true
          ? new SyntaxFile(input.text ?? "", parsed.program, parsed.comments)
          : null;
      const notRead: Hexagon["notRead"] = [];
      value = {
        parsed: syntax !== null,
        ports: readPorts(syntax, notRead),
        notRead,
      };
    }
    return { value, thrown: null };
  } catch (error) {
    return { value: null, thrown: exception(error) };
  }
}
