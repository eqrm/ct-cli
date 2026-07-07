#!/usr/bin/env node
import { Command } from "commander";
import { authCommand } from "./commands/auth.js";
import { getCommand } from "./commands/get.js";
import { adoptCommand } from "./commands/adopt.js";
import { stateCommand } from "./commands/state.js";
import { plannedCommands } from "./commands/placeholders.js";
import { isMainModule } from "./isMain.js";
import { error } from "./ui.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ct")
    .description(
      "ChurchTools structure-as-code CLI — declarative plan/apply for the overarching, " +
        "rights-bearing structure. Never manages people.",
    )
    .version("0.0.0");

  program.addCommand(authCommand());
  program.addCommand(getCommand());
  program.addCommand(adoptCommand());
  program.addCommand(stateCommand());
  for (const cmd of plannedCommands()) {
    program.addCommand(cmd);
  }

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

/** Only run when invoked as the binary — importing this module (tests) must not parse argv. */
if (isMainModule(process.argv[1], import.meta.url)) {
  void main();
}
