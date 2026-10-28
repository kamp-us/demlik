import fs from "node:fs";
import { pathToFileURL } from "node:url";

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.argv = [process.execPath, input.index, ...input.argv];
if (input.initial !== undefined) process.exitCode = input.initial;
await import(pathToFileURL(input.index).href);
