import { readHexagon } from "./read.js";
import { renderHexagon } from "./render.js";

export function runHexagon(
  root: string,
  out: {
    json: boolean;
    pretty: boolean;
    emit: (text: string) => void;
    report: (error: string) => void;
  },
): void {
  try {
    out.emit(`${renderHexagon(readHexagon(root), out.json, out.pretty)}\n`);
  } catch (error) {
    out.report(error instanceof Error ? error.message : String(error));
  }
}
