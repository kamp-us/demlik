import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";

const request = z
  .object({ ioTrace: z.string(), driftFile: z.string().optional() })
  .parse(
    JSON.parse(
      fs.readFileSync(process.env.DEMLIK_FRONTDOOR_REQUEST ?? "", "utf8"),
    ),
  );
let drifted = false;
const original = childProcess.spawn;
childProcess.spawn = new Proxy(original, {
  apply(target, receiver, args) {
    if (request.driftFile && !drifted && String(args[0]).endsWith("/tsgo")) {
      drifted = true;
      const source = fs.readFileSync(request.driftFile, "utf8");
      fs.writeFileSync(
        request.driftFile,
        `// edit after syntax load\n${source}`,
      );
      fs.appendFileSync(
        request.ioTrace,
        `${JSON.stringify({ op: "controlled-loaded-source-drift", file: request.driftFile })}\n`,
      );
    }
    return Reflect.apply(target, receiver, args);
  },
});
syncBuiltinESMExports();
await import("./cli-layer-source.mjs");
