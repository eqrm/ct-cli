import { createInterface } from "node:readline";
import { Command } from "commander";
import { loginWithToken } from "../auth/login.js";
import { supportsCredentialStorage } from "../auth/tokenStore.js";
import { initializeConfigRepository } from "../init.js";
import { askSecret } from "../ui/prompt.js";
import { info, success } from "../ui.js";
import { reportLogin } from "./auth.js";

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
        if (process.stdin.isTTY && !opts.yes && supportsCredentialStorage()) {
          const token = (
            await askSecret("Personal login token (input hidden; leave empty to log in later): ")
          ).trim();
          if (token) {
            reportLogin(await loginWithToken(result.host!, token));
            info(`Next: run \`ct coverage --env ${result.environment}\`.`);
            return;
          }
        }
        if (supportsCredentialStorage()) {
          info(
            `Next: run \`ct auth login --host ${result.host}\`, then \`ct coverage --env ${result.environment}\`.`,
          );
        } else {
          info(
            `Next: set \`CT_HOST=${result.host}\` and \`CT_LOGINTOKEN\` in your environment, ` +
              `then run \`ct coverage --env ${result.environment}\`.`,
          );
        }
      }
    });
}
