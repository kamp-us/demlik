import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

describe("source hygiene", () => {
  it("no source file under src/ contains a NUL byte (git treats NUL files as binary)", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const idx = fs.readFileSync(file).indexOf(0x00);
      if (idx >= 0) offenders.push(`${path.relative(SRC_DIR, file)}:byte${idx}`);
    }
    expect(offenders, `NUL byte(s) found: ${offenders.join(", ")}`).toEqual([]);
  });
});
