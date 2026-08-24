import { Argument, Command } from "commander";
import { COMPLETION_SHELLS, completionScript, type CompletionShell } from "../completion/shell.js";

export function completionCommand(): Command {
  return new Command("completion")
    .description("Print the shell hook that makes Tab complete `ct` (zsh, bash, fish)")
    .addArgument(new Argument("<shell>", "shell to print the hook for").choices([...COMPLETION_SHELLS]))
    .action((shell: CompletionShell, _options: unknown, command: Command) => {
      // The hook completes the program it is attached to, so it is generated from the
      // root program rather than from this subcommand.
      process.stdout.write(completionScript(command.parent ?? command, shell));
    });
}
