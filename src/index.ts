#!/usr/bin/env node
import { Command } from "commander";
import packageJson from "../package.json" with { type: "json" };
import { authCommand } from "./commands/auth.js";
import { getCommand } from "./commands/get.js";
import { adoptCommand } from "./commands/adopt.js";
import { stateCommand } from "./commands/state.js";
import { coverageCommand } from "./commands/coverage.js";
import { permissionsCommand } from "./commands/permissions.js";
import { reportCommand } from "./commands/report.js";
import { refreshCommand } from "./commands/refresh.js";
import { planCommand } from "./commands/plan.js";
import { applyCommand } from "./commands/apply.js";
import { destroyCommand } from "./commands/destroy.js";
import { plannedCommands } from "./commands/placeholders.js";
import { isMainModule } from "./isMain.js";
import { error, formatError } from "./ui.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ct")
    .description(
      "ChurchTools structure-as-code CLI — declarative plan/apply for the overarching, " +
        "rights-bearing structure. Never manages people.",
    )
    .version(packageJson.version);

  program.addCommand(authCommand());
  program.addCommand(getCommand());
  program.addCommand(adoptCommand());
  program.addCommand(stateCommand());
  program.addCommand(coverageCommand());
  program.addCommand(permissionsCommand());
  program.addCommand(reportCommand());
  program.addCommand(refreshCommand());
  program.addCommand(planCommand());
  program.addCommand(applyCommand());
  program.addCommand(destroyCommand());
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
    error(formatError(err));
    process.exitCode = 1;
  }
}

/** Only run when invoked as the binary — importing this module (tests) must not parse argv. */
if (isMainModule(process.argv[1], import.meta.url)) {
  void main();
}
