import path from "node:path";
import { parseTypeScript } from "../engine/oxc.js";
import type { SourceUnit } from "../extract/project.js";
import { SyntaxFile } from "../syntax/file.js";

export function sourceUnit(source: string, file = "fixture.ts"): SourceUnit {
  const absolutePath = path.join("/", file);
  const parsed = parseTypeScript(absolutePath, source);
  if (!parsed.ok) throw new Error(`fixture ${file} does not parse`);
  return {
    absolutePath,
    file,
    syntax: new SyntaxFile(source, parsed.program, parsed.comments),
  };
}
