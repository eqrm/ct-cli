import { Command } from "commander";
import { listEnvironments } from "../application/operations/environment.js";
import { out } from "../ui.js";

export function environmentCommand(): Command {
  const command = new Command("environment")
    .alias("env")
    .description("Discover the configured ChurchTools environments");
  command
    .command("list")
    .description("List non-secret environment profiles")
    .action(async () => {
      const result = await listEnvironments();
      out({ path: result.environmentsPath, environments: result.environments });
    });
  return command;
}
