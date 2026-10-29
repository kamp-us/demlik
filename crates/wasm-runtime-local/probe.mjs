import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(pathToFileURL(`${process.cwd()}/`));
const host = require(process.argv[2]);
const action = process.argv[3];
try {
  const value = await host[action]();
  console.log(JSON.stringify({ action, value }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
