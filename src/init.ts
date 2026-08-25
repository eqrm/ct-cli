import { execFile as execFileCallback } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { normalizeHost } from "./config.js";
import { emptyState } from "./state/state.js";

const execFile = promisify(execFileCallback);

export const INIT_FILES = ["ct.config.ts", "ct.envs.json", ".gitignore"] as const;
export const INIT_DIRECTORIES = ["config", "blueprints"] as const;
export const PROCESS_INIT_FILES = ["ct.config.ts", "ct.envs.json", ".gitignore", "README.md"] as const;
export const PROCESS_INIT_DIRECTORIES = ["blueprint", "configs", "instances"] as const;

export type InitTemplate = "standard" | "process";

const CONFIG_TEMPLATE = `/** Desired ChurchTools structure. Add declarations inside this function. */
export default (ct) => {
  // Example: ct.campus({ key: "main", name: "Main Campus", shorty: "MAIN" });
};
`;

const GITIGNORE_TEMPLATE = `# Local secrets
.env
.env.*

# Generated local output
backups/
node_modules/
reference/
reports/
.DS_Store

# ct-state*.json files intentionally stay tracked: they record what ct manages.
`;

const PROCESS_GITIGNORE_TEMPLATE = `# Local secrets
.env
.env.*

# Generated local output belongs to one ChurchTools instance and is not committed.
instances/*/backups/
instances/*/reference/
instances/*/reports/
node_modules/
.DS_Store

# Host-bound ct-state*.json files intentionally stay tracked: they record what ct manages.
`;

export interface InitOptions {
  template?: string;
  host?: string;
  environment?: string;
  protected?: boolean;
  git?: boolean;
  /** Skip all questions. Useful for scripts and tests. */
  yes?: boolean;
  isTTY?: boolean;
  ask?: (question: string) => Promise<string>;
  runGitInit?: (directory: string) => Promise<void>;
}

export interface InitResult {
  directory: string;
  template: InitTemplate;
  files: string[];
  directories: string[];
  host?: string;
  hostname?: string;
  environment?: string;
  protected?: boolean;
  gitInitialized: boolean;
}

function validateTemplate(template: string | undefined): InitTemplate {
  const value = template?.trim() || "standard";
  if (value !== "standard" && value !== "process") {
    throw new Error(`Unknown init template "${value}". Available templates: standard, process.`);
  }
  return value;
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

function validateHost(host: string): { host: string; hostname: string } {
  const normalized = normalizeHost(host.trim());
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`Invalid ChurchTools URL "${host}". Expected e.g. https://example.church.tools.`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) {
    throw new Error(`Invalid ChurchTools URL "${host}". Expected an http(s) URL.`);
  }
  if (url.username || url.password) {
    throw new Error(
      "ChurchTools URL must not contain credentials. Tokens are never written to the scaffold.",
    );
  }
  // A URL copied out of the browser address bar carries the SPA's query and
  // fragment (".../?q=churchdb#/churchdb"). Every request is built as
  // `${host}/api/...`, so those would survive into every call. A path is left
  // alone: it is how a sub-path installation is addressed.
  if (url.search || url.hash) {
    throw new Error(
      `Invalid ChurchTools URL "${host}". Drop the "?"/"#" part and pass the base URL, ` +
        `e.g. ${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}.`,
    );
  }
  return { host: normalizeHost(url.toString()), hostname: url.hostname };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface EnvironmentTemplateOptions {
  host?: string;
  environment?: string;
  statePath?: string;
  protected?: boolean;
  explicitProcessBinding?: boolean;
}

function envsTemplate(options: EnvironmentTemplateOptions): string {
  const environments: Record<string, { host: string; state?: string; protected?: boolean }> = {};
  if (options.host && options.environment) {
    const profile: { host: string; state?: string; protected?: boolean } = { host: options.host };
    if (options.statePath) profile.state = options.statePath;
    if (options.explicitProcessBinding || options.protected !== undefined) {
      profile.protected = options.protected === true;
    }
    environments[options.environment] = profile;
  }
  return `${JSON.stringify({ environments }, null, 2)}\n`;
}

function processReadme(environment?: string): string {
  const env = environment ?? "<environment>";
  return `# ChurchTools process

This directory contains one portable ChurchTools process. Run all \`ct\` commands from this
directory so the root-level \`ct.config.ts\` and \`ct.envs.json\` are selected automatically.

## Standard workflow

\`\`\`bash
ct plan -e ${env}
ct apply -e ${env}
\`\`\`

Always pass \`-e ${env}\`. Until the separate engine-wide environment guard is implemented, omitting
\`-e\` selects ct-cli's single-instance fallback instead of this process's explicit host/state binding.

Portable process definitions belong in \`blueprint/\`. Keep instance-specific state, reports,
backups and captured reference data below \`instances/<hostname>/\`. Never store login tokens in
this repository.

Exceptional entry points, such as a staged bootstrap for an empty instance, belong in \`configs/\`
and are selected explicitly:

\`\`\`bash
ct plan -c configs/<bootstrap-config>.ts -e ${env}
\`\`\`
`;
}

async function existingPaths(directory: string, paths: readonly string[]): Promise<string[]> {
  const conflicts: string[] = [];
  for (const path of paths) {
    if (await pathExists(resolve(directory, path))) conflicts.push(path);
  }
  return conflicts;
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
  const template = validateTemplate(options.template);
  const rootFiles = template === "process" ? [...PROCESS_INIT_FILES] : [...INIT_FILES];

  // Check every fixed root file before asking questions. Host-derived paths are checked after the
  // host prompt, still before mkdir/writeFile, so every refusal is free of partial scaffold writes.
  const conflicts = await existingPaths(directory, rootFiles);
  if (conflicts.length > 0) {
    throw new Error(
      `Cannot initialize ${directory}: refusing to overwrite existing ${conflicts.join(", ")}.`,
    );
  }

  const isTTY = options.isTTY ?? Boolean(process.stdin.isTTY);
  const interactive = isTTY && !options.yes && options.ask !== undefined;
  const ask = options.ask;

  let host = options.host?.trim();
  let hostname: string | undefined;
  let environment = options.environment?.trim();
  let protectedEnvironment = options.protected;
  let initializeGit = options.git;

  if (interactive && !host) host = (await ask!("ChurchTools URL (leave empty to configure later): ")).trim();
  if (host) {
    ({ host, hostname } = validateHost(host));
    if (!environment && interactive) {
      environment = (await ask!("First environment name [prod]: ")).trim() || "prod";
    }
    environment = validateEnvironment(environment || "prod");
    if (template === "process" && interactive && protectedEnvironment === undefined) {
      const answer = (await ask!("Protect this environment? [y/N] ")).trim();
      protectedEnvironment = /^y(es)?$/i.test(answer);
    }
  } else if (environment) {
    throw new Error("--env requires --host so the generated environment profile is usable.");
  } else if (protectedEnvironment !== undefined) {
    throw new Error("--protected requires --host so the generated environment profile is usable.");
  }
  // Asking about `git init` in a directory that is already a repository would
  // collect an answer this function then silently drops below.
  const alreadyGit = await pathExists(resolve(directory, ".git"));
  if (interactive && initializeGit === undefined && !alreadyGit) {
    const answer = (await ask!("Initialize a Git repository? [y/N] ")).trim();
    initializeGit = /^y(es)?$/i.test(answer);
  }
  initializeGit ??= false;

  const statePath =
    template === "process" && host && hostname
      ? `instances/${hostname}/ct-state.${hostname}.json`
      : undefined;
  const files = [...rootFiles, ...(statePath ? [statePath] : [])];
  const derivedConflicts = await existingPaths(directory, files);
  if (derivedConflicts.length > 0) {
    throw new Error(
      `Cannot initialize ${directory}: refusing to overwrite existing ${derivedConflicts.join(", ")}.`,
    );
  }

  const directories =
    template === "process"
      ? [
          ...PROCESS_INIT_DIRECTORIES,
          ...(hostname
            ? [
                `instances/${hostname}/backups`,
                `instances/${hostname}/reference`,
                `instances/${hostname}/reports`,
              ]
            : []),
        ]
      : [...INIT_DIRECTORIES];

  await mkdir(directory, { recursive: true });
  for (const name of directories) await mkdir(resolve(directory, name), { recursive: true });

  const contents = new Map<string, string>([
    ["ct.config.ts", CONFIG_TEMPLATE],
    [
      "ct.envs.json",
      envsTemplate({
        host,
        environment,
        statePath,
        protected: protectedEnvironment,
        explicitProcessBinding: template === "process",
      }),
    ],
    [".gitignore", template === "process" ? PROCESS_GITIGNORE_TEMPLATE : GITIGNORE_TEMPLATE],
  ]);
  if (template === "process") contents.set("README.md", processReadme(environment));
  if (statePath && host) contents.set(statePath, `${JSON.stringify(emptyState(host), null, 2)}\n`);

  await Promise.all(
    [...contents].map(([path, content]) =>
      writeFile(resolve(directory, path), content, { encoding: "utf8", flag: "wx" }),
    ),
  );

  const gitInitialized = initializeGit && !alreadyGit;
  if (gitInitialized) {
    await (options.runGitInit ?? defaultGitInit)(directory);
  }

  return {
    directory,
    template,
    files,
    directories,
    host,
    hostname,
    environment,
    protected: host ? protectedEnvironment === true : undefined,
    gitInitialized,
  };
}
