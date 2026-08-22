import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { normalizeHost } from "./config.js";

const execFile = promisify(execFileCallback);

export const INIT_FILES = ["ct.config.ts", "ct.envs.json", ".gitignore"] as const;
export const INIT_DIRECTORIES = ["config", "blueprints"] as const;

const CONFIG_TEMPLATE = `/** Desired ChurchTools structure. Add declarations inside this function. */
export default (ct) => {
  // Example: ct.campus({ key: "main", name: "Main Campus", shorty: "MAIN" });
};
`;

const GITIGNORE_TEMPLATE = `# Local secrets
.env
.env.*

# Generated local output
node_modules/
reference/
reports/
.DS_Store

# ct-state*.json files intentionally stay tracked: they record what ct manages.
`;

export interface InitOptions {
  host?: string;
  environment?: string;
  git?: boolean;
  /** Skip all questions. Useful for scripts and tests. */
  yes?: boolean;
  isTTY?: boolean;
  ask?: (question: string) => Promise<string>;
  runGitInit?: (directory: string) => Promise<void>;
}

export interface InitResult {
  directory: string;
  files: string[];
  directories: string[];
  host?: string;
  environment?: string;
  gitInitialized: boolean;
}

function validateEnvironment(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    throw new Error(
      `Invalid environment name "${name}". Use letters, numbers, dots, underscores or hyphens.`,
    );
  }
  return trimmed;
}

function validateHost(host: string): string {
  const trimmed = normalizeHost(host.trim());
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid ChurchTools URL "${host}". Expected e.g. https://example.church.tools.`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) {
    throw new Error(`Invalid ChurchTools URL "${host}". Expected an http(s) URL.`);
  }
  return trimmed;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function envsTemplate(host?: string, environment?: string): string {
  const environments: Record<string, { host: string }> = {};
  if (host && environment) environments[environment] = { host };
  return `${JSON.stringify({ environments }, null, 2)}\n`;
}

async function defaultGitInit(directory: string): Promise<void> {
  await execFile("git", ["init"], { cwd: directory });
}

/**
 * Scaffold a config repository without touching ChurchTools or credentials.
 * Existing scaffold files are rejected in a preflight check and never overwritten.
 */
export async function initializeConfigRepository(
  targetDirectory: string,
  options: InitOptions = {},
): Promise<InitResult> {
  const directory = resolve(targetDirectory);

  const conflicts: string[] = [];
  for (const file of INIT_FILES) {
    if (await pathExists(resolve(directory, file))) conflicts.push(file);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Cannot initialize ${directory}: refusing to overwrite existing ${conflicts.join(", ")}.`,
    );
  }

  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const interactive = isTTY && !options.yes && options.ask !== undefined;
  const ask = options.ask;

  let host = options.host?.trim();
  let environment = options.environment?.trim();
  let initializeGit = options.git;

  if (interactive && !host) host = (await ask!("ChurchTools URL (leave empty to configure later): ")).trim();
  if (host) {
    host = validateHost(host);
    if (!environment && interactive) {
      environment = (await ask!("First environment name [prod]: ")).trim() || "prod";
    }
    environment = validateEnvironment(environment || "prod");
  } else if (environment) {
    throw new Error("--env requires --host so the generated environment profile is usable.");
  }
  if (interactive && initializeGit === undefined) {
    const answer = (await ask!("Initialize a Git repository? [y/N] ")).trim();
    initializeGit = /^y(es)?$/i.test(answer);
  }
  initializeGit ??= false;

  await mkdir(directory, { recursive: true });
  for (const name of INIT_DIRECTORIES) await mkdir(resolve(directory, name), { recursive: true });
  await Promise.all([
    writeFile(resolve(directory, "ct.config.ts"), CONFIG_TEMPLATE, { encoding: "utf8", flag: "wx" }),
    writeFile(resolve(directory, "ct.envs.json"), envsTemplate(host, environment), {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(resolve(directory, ".gitignore"), GITIGNORE_TEMPLATE, { encoding: "utf8", flag: "wx" }),
  ]);

  const gitInitialized = initializeGit && !(await pathExists(resolve(directory, ".git")));
  if (gitInitialized) {
    await (options.runGitInit ?? defaultGitInit)(directory);
  }

  return {
    directory,
    files: [...INIT_FILES],
    directories: [...INIT_DIRECTORIES],
    host,
    environment,
    gitInitialized,
  };
}
