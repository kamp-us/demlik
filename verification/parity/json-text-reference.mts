import readline from "node:readline";

const unpaired = /[\uD800-\uDFFF]/u;
function normalize(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { $number: String(value) };
    if (Object.is(value, -0)) return { $number: "-0" };
  }
  if (typeof value === "string" && unpaired.test(value))
    return {
      $utf16: Array.from({ length: value.length }, (_, i) =>
        value.charCodeAt(i),
      ),
    };
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.some(([key]) => unpaired.test(key)))
      return {
        $object: entries.map(([key, value]) => [
          normalize(key),
          normalize(value),
        ]),
      };
    return Object.fromEntries(
      entries.map(([key, value]) => [key, normalize(value)]),
    );
  }
  return value;
}
for await (const line of readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  const input = JSON.parse(line);
  try {
    const value = JSON.parse(String.fromCharCode(...input.units));
    process.stdout.write(
      `${JSON.stringify({ id: input.id, ok: true, value: normalize(value) })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id: input.id, ok: false, error: { name: error instanceof Error ? error.name : "unknown", message: normalize(error instanceof Error ? error.message : String(error)) } })}\n`,
    );
  }
}
