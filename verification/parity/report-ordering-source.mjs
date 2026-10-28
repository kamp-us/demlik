import assert from "node:assert/strict";
import fs from "node:fs";
import { reference } from "./report-ordering-reference.mjs";

assert.deepEqual(
  [
    process.version,
    process.versions.v8,
    process.versions.icu,
    Intl.Collator().resolvedOptions().locale,
  ],
  ["v22.21.1", "12.4.254.21-node.33", "77.1", "en-US"],
);
const packet = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const output = reference(packet.input, packet.directory, packet.saved);
fs.writeFileSync(packet.response, `${JSON.stringify(output)}\n`);
