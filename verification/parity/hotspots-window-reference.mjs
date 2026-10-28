import assert from "node:assert/strict";
import fs from "node:fs";

const [profile, zone] = process.argv.slice(2);
assert.ok(["window", "parser"].includes(profile));
assert.equal(process.version, "v22.21.1");
assert.equal(process.versions.v8, "12.4.254.21-node.33");
assert.equal(process.versions.icu, "77.1");
assert.equal(process.versions.tz, "2025b");
assert.equal(process.env.TZ, zone);
const cases = JSON.parse(
  fs.readFileSync(
    new URL("./hotspots-window-cases.json", import.meta.url),
    "utf8",
  ),
).filter((row) => row.profile === profile && row.input.zone === zone);
assert.equal(cases.length, profile === "window" ? 36 : 8);
const OriginalDate = Date;
const fixed = profile === "window" ? 1793102400123.75 : 1793102400123;
let reads = 0;
class FixedDate extends OriginalDate {
  constructor(...args) {
    if (args.length === 0) {
      reads++;
      super(fixed);
    } else super(...args);
  }
  static now() {
    return new OriginalDate(fixed).getTime();
  }
}
globalThis.Date = FixedDate;
const { resolveChurnWindow } = await import(
  "../../packages/code-graph/src/hotspots/churn.ts"
);
const rows = cases.map((row) => {
  reads = 0;
  const days =
    typeof row.input.days === "string"
      ? Number(row.input.days)
      : row.input.days;
  let output, error;
  try {
    output = resolveChurnWindow(days, row.input.since);
  } catch (cause) {
    error = { name: cause.name, message: cause.message };
  }
  return {
    id: row.id,
    ...(Object.hasOwn(row.input, "since") ? { since: row.input.since } : {}),
    ...(profile === "window"
      ? { days: row.input.days, clockReads: reads }
      : {}),
    ...(output ? { output } : { error }),
  };
});
process.stdout.write(
  `${JSON.stringify(
    {
      node: process.version,
      v8: process.versions.v8,
      icu: process.versions.icu,
      tz: process.versions.tz,
      TZ: zone,
      profile,
      frozenRequestedMs: fixed,
      rows,
    },
    null,
    2,
  )}\n`,
);
