import { createInterface } from "node:readline";
import { Command } from "commander";
import { bootstrapLoginToken } from "../auth/login.js";
import { isSecureStorageAvailable } from "../auth/tokenStore.js";
import { initializeConfigRepository } from "../init.js";
import { info, success } from "../ui.js";
import { verifyAndStoreLoginToken } from "./auth.js";

interface InitCommandOptions {
  template?: string;
  host?: string;
  env?: string;
  protected?: boolean;
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
    .description("Initialize a new ct config repository or portable process workspace")
    .argument("[directory]", "target directory", ".")
    .option("--template <name>", "scaffold template: standard or process", "standard")
    .option("--host <url>", "ChurchTools URL for the first environment")
    .option("--env <name>", "name of the first environment (default: prod)")
    .option("--protected", "mark the first environment as protected")
    .option("--git", "initialize a Git repository")
    .option("--no-git", "do not initialize a Git repository")
    .option("-y, --yes", "accept defaults and do not prompt")
    .action(async (directory: string, opts: InitCommandOptions) => {
      const result = await initializeConfigRepository(directory, {
        template: opts.template,
        host: opts.host,
        environment: opts.env,
        protected: opts.protected,
        git: opts.git,
        yes: opts.yes,
        ask,
      });

      success(`Initialized ct config repository in ${result.directory}`);
      info(`Created: ${[...result.files, ...result.directories.map((name) => `${name}/`)].join(", ")}`);
      if (!result.environment) {
        info(
          result.template === "process"
            ? "Next: add a host-bound environment to ct.envs.json, then run `ct plan -e <environment>`."
            : "Next: add an environment to ct.envs.json, then run `ct auth login --host <url> --token <token>`.",
        );
      } else {
        const inspectCommand =
          result.template === "process"
            ? `ct plan -e ${result.environment}`
            : `ct coverage --env ${result.environment}`;
        if (process.stdin.isTTY && !opts.yes && isSecureStorageAvailable()) {
          const outcome = await bootstrapLoginToken(result.host!);
          if (outcome.kind === "token") {
            await verifyAndStoreLoginToken(result.host!, outcome.token);
            info(`Next: run \`${inspectCommand}\`.`);
            return;
          }
        }
        if (isSecureStorageAvailable()) {
          info(`Next: run \`ct auth login --host ${result.host}\`, then \`${inspectCommand}\`.`);
        } else {
          info(
            `Next: set \`CT_HOST=${result.host}\` and \`CT_LOGINTOKEN\` in your environment, ` +
              `then run \`${inspectCommand}\`.`,
          );
        }
      }
    });
}
