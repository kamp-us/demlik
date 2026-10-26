import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { z } from "zod";

const request = z
  .object({ fixture: z.string(), ioTrace: z.string() })
  .parse(
    JSON.parse(
      fs.readFileSync(process.env.DEMLIK_FRONTDOOR_REQUEST ?? "", "utf8"),
    ),
  );
const append = fs.appendFileSync;
for (const name of ["rmSync", "unlinkSync"] as const) {
  const original = fs[name];
  fs[name] = new Proxy(original, {
    apply(target, receiver, args) {
      const file = args[0];
      const observed =
        typeof file === "string" &&
        path.resolve(file).startsWith(`${request.fixture}/`);
      if (observed)
        append(request.ioTrace, `${JSON.stringify({ op: name, file })}\n`);
      const result = Reflect.apply(target, receiver, args);
      if (observed)
        append(
          request.ioTrace,
          `${JSON.stringify({ op: `${name}-return`, file })}\n`,
        );
      return result;
    },
  });
}
syncBuiltinESMExports();
await import("./cli-layer-source.mjs");
