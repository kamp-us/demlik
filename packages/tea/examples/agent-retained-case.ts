import { runFixture } from "./retained-case/fixture";

const directory = process.argv[2];
if (!directory)
  throw new Error("Pass a case directory to examples/retained-case/run.mjs");
const view = await runFixture(directory);
console.log(JSON.stringify(view, null, 2));
