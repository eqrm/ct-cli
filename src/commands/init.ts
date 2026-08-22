import { createInterface } from "node:readline";
import { Command } from "commander";
import { initializeConfigRepository } from "../init.js";
import { info, success } from "../ui.js";

interface InitCommandOptions {
  host?: string;
  env?: string;
  git?: boolean;
  yes?: boolean;
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function initCommand(): Command {
  return new Command("init")
    .description("Initialize a new ct config repository")
    .argument("[directory]", "target directory", ".")
    .option("--host <url>", "ChurchTools URL for the first environment")
    .option("--env <name>", "name of the first environment (default: prod)")
    .option("--git", "initialize a Git repository")
    .option("--no-git", "do not initialize a Git repository")
    .option("-y, --yes", "accept defaults and do not prompt")
    .action(async (directory: string, opts: InitCommandOptions) => {
      const result = await initializeConfigRepository(directory, {
        host: opts.host,
        environment: opts.env,
        git: opts.git,
        yes: opts.yes,
        ask,
      });

      success(`Initialized ct config repository in ${result.directory}`);
      info(`Created: ${[...result.files, ...result.directories.map((name) => `${name}/`)].join(", ")}`);
      if (!result.environment) {
        info(
          "Next: add an environment to ct.envs.json, then run `ct auth login --host <url> --token <token>`.",
        );
      } else {
        info(
          `Next: run \`ct auth login --host ${result.host} --token <token>\`, then \`ct coverage --env ${result.environment}\`.`,
        );
      }
    });
}
