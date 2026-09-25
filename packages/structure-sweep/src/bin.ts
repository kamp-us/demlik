#!/usr/bin/env node
import { CONSOLIDATE_USAGE, consolidateCommand } from "./consolidate/cli.js";
import { MOVE_USAGE, moveCommand } from "./move/cli.js";
import { PAIRS_USAGE, pairsCommand } from "./pairs/cli.js";
import { SCORE_USAGE, scoreCommand } from "./score/cli.js";
import { SWEEP_USAGE, sweepCommand } from "./sweep/cli.js";

const USAGE = [
  SWEEP_USAGE,
  PAIRS_USAGE,
  MOVE_USAGE,
  SCORE_USAGE,
  CONSOLIDATE_USAGE,
].join("\n\n");

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "sweep":
      return sweepCommand(rest, process.cwd());
    case "pairs":
      return pairsCommand(rest, process.cwd());
    case "move":
      return moveCommand(rest, process.cwd());
    case "score":
      return scoreCommand(rest, process.cwd());
    case "consolidate":
      return consolidateCommand(rest, process.cwd());
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(
    `structure-sweep: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
