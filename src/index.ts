#!/usr/bin/env node
import { Command } from "commander";
import { plannedCommands } from "./commands/placeholders.js";
import { operationCatalog } from "./operations/catalog.js";
import { buildCliProjection } from "./operations/cli-projection.js";
import { isCompletionRequest, serveCompletionRequest } from "./completion/shell.js";
import { isMainModule } from "./isMain.js";
import { versionLine } from "./version.js";
import { error, formatError } from "./ui.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("ct")
    .description(
      "ChurchTools structure-as-code CLI — declarative plan/apply for the overarching, " +
        "rights-bearing structure. Never manages people.",
    )
    .version(versionLine(import.meta.url));

  for (const command of buildCliProjection(operationCatalog)) program.addCommand(command);
  for (const cmd of plannedCommands()) {
    program.addCommand(cmd);
  }

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  // A Tab keypress re-enters `ct` with the shell hook's plumbing flags (#132). Answer
  // from the command tree and exit before Commander ever sees them.
  if (isCompletionRequest(process.argv)) {
    serveCompletionRequest(program);
    return;
  }
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
