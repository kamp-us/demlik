import fs from "node:fs";

const prefix = process.env.DEMLIK_PREFLIGHT_FIXTURE ?? "";
const trace = process.env.DEMLIK_PREFLIGHT_IO ?? "";
function observed<T extends typeof fs.readFileSync | typeof fs.writeFileSync>(
  operation: "read" | "write",
  target: T,
): T {
  return new Proxy(target, {
    apply(original, receiver, args) {
      const file = String(args[0]);
      if (prefix !== "" && file.startsWith(prefix))
        fs.appendFileSync(
          trace,
          `${JSON.stringify({ op: operation, file })}\n`,
        );
      return Reflect.apply(original, receiver, args);
    },
  });
}
fs.readFileSync = observed("read", fs.readFileSync);
fs.writeFileSync = observed("write", fs.writeFileSync);
await import("./cli-frontdoor-source.mjs");
