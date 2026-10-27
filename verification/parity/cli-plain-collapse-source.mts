import fs from "node:fs";
import { z } from "zod";

const request = z
  .object({ warningMarker: z.string().optional() })
  .parse(
    JSON.parse(
      fs.readFileSync(process.env.DEMLIK_FRONTDOOR_REQUEST ?? "", "utf8"),
    ),
  );
let marked = false;
const original = process.stderr.write;
process.stderr.write = new Proxy(original, {
  apply(target, receiver, args) {
    const result = Reflect.apply(target, receiver, args);
    if (
      !marked &&
      request.warningMarker &&
      String(args[0]).startsWith("warning: --by ")
    ) {
      fs.writeFileSync(request.warningMarker, "packages: []\n");
      marked = true;
    }
    return result;
  },
});
await import("./cli-collapse-source.mts");
