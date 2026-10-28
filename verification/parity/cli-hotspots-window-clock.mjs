import fs from "node:fs";

const input = JSON.parse(
  fs.readFileSync(process.env.DEMLIK_FRONTDOOR_REQUEST, "utf8"),
);
const NativeDate = Date;
const calls = [];
const number = (value) => (Number.isFinite(value) ? value : String(value));
class FixedDate extends NativeDate {
  constructor(...args) {
    super(...(args.length === 0 ? [input.clockMs] : args));
    const stack = new Error().stack;
    if (stack?.includes("/hotspots/churn.ts:")) {
      calls.push({
        kind: args.length === 0 ? "clock" : "date",
        args,
        milliseconds: number(this.getTime()),
        stack,
      });
    }
  }
  static now() {
    return new NativeDate(input.clockMs).getTime();
  }
}
globalThis.Date = FixedDate;
process.on("exit", () =>
  fs.writeFileSync(
    input.clockTrace,
    JSON.stringify({
      node: process.version,
      versions: {
        v8: process.versions.v8,
        icu: process.versions.icu,
        tz: process.versions.tz,
      },
      requestedClockMs: input.clockMs,
      clippedClockMs: number(new NativeDate(input.clockMs).getTime()),
      TZ: process.env.TZ ?? null,
      resolvedZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
      calls,
    }) + "\n",
  ),
);
