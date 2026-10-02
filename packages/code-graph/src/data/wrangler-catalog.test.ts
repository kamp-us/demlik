import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadBindingCatalog } from "../extract/wrangler-config.js";
import { BOM, MID_FILE_ERRORS, SEARCH_CONFIG } from "../test-helpers/wrangler-configs.js";

type Lands = "manifests" | "unparsedConfigs";
type Row = readonly [name: string, file: string, text: string, lands: Lands];

const JSONC = "wrangler.jsonc";

// The rows are wrangler's reader (`parseJSONC`, used for `.json` and `.jsonc` alike): comments,
// trailing commas and a leading BOM are read, and every other syntax error leaves the file unparsed.
const ROWS: readonly Row[] = [
  ["a line comment", JSONC, '// a worker\n{ "name": "a" }\n', "manifests"],
  ["a block comment", JSONC, '/* a worker */ { "name": "a" }\n', "manifests"],
  ["a trailing comma in an object", JSONC, '{ "name": "a", }\n', "manifests"],
  [
    "a trailing comma in an array",
    JSONC,
    '{ "services": [{ "binding": "B", "service": "b" },] }',
    "manifests",
  ],
  ["a trailing comma in a .json config", "wrangler.json", '{ "name": "a", }\n', "manifests"],
  ["a leading BOM", JSONC, `${BOM}{ "name": "a" }\n`, "manifests"],
  ["a config with a BOM, comments and trailing commas", JSONC, SEARCH_CONFIG, "manifests"],
  ...MID_FILE_ERRORS.map(({ name, text }): Row => [name, JSONC, text, "unparsedConfigs"]),
  ["an empty file", JSONC, "", "unparsedConfigs"],
  ["text that is not an object", JSONC, "not a wrangler config\n", "unparsedConfigs"],
  [
    "a TOML file with a syntax error",
    "wrangler.toml",
    'name = "a\nmain = "src/index.ts"\n',
    "unparsedConfigs",
  ],
];

describe("the wrangler config loader reads a config as wrangler does", () => {
  it.each(ROWS)("%s", (_name, file, text, lands) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cg-wrangler-config-"));
    try {
      fs.writeFileSync(path.join(root, file), text);
      const catalog = loadBindingCatalog(root);
      const landed = {
        manifests: catalog.manifests.map((manifest) => manifest.configFile),
        unparsedConfigs: catalog.unparsedConfigs,
      };
      expect(landed).toEqual({ manifests: [], unparsedConfigs: [], [lands]: [file] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
