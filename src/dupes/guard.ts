/**
 * Personal-data guard for `ct dupes`.
 *
 * Against a protected (or unknown) environment the command only runs for a human at a terminal:
 * stdin and stdout must be TTYs, no coding-agent marker may be in the environment, and no
 * ancestor process may be a coding-agent CLI. If the ancestors cannot be read, the command
 * refuses (fail closed). This is best-effort detection of known tools, not a guarantee.
 * There is deliberately no flag or variable that skips it.
 */
import { execFileSync } from "node:child_process";
import type { EnvProfile } from "../env/envs.js";

export interface GuardInput {
  /** The selected profile, or null when no `--env` was given. */
  profile: Pick<EnvProfile, "protected" | "gateway"> | null;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: NodeJS.ProcessEnv;
  /** Command lines (or names) of this process's ancestors, nearest first; throws when unavailable. */
  ancestors?: () => string[];
}

/**
 * Exact variable names that coding-agent CLIs set inside the shells they run.
 * Only runtime markers belong here: configuration variables a person may export in their
 * own shell profile (CODEX_HOME, AIDER_MODEL, editor-terminal CURSOR_* ids) would lock
 * humans out, so tool prefixes are deliberately not matched.
 */
const AGENT_ENV_NAMES = new Set([
  "CLAUDECODE",
  "AI_AGENT",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
  "OPENCODE",
]);

/** Variable name prefixes used by coding-agent CLIs (kept from the original Claude Code check). */
const AGENT_ENV_PREFIXES = ["CLAUDE_CODE_"];

/** Environment markers set by coding-agent CLIs (a list of known tools). */
export function agentMarkers(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter(
    (k) =>
      env[k] !== undefined && (AGENT_ENV_NAMES.has(k) || AGENT_ENV_PREFIXES.some((p) => k.startsWith(p))),
  );
}

/** Whether this env holds data the guard protects. Unknown (no `--env`) counts as protected. */
export function needsGuard(profile: GuardInput["profile"]): boolean {
  return profile === null || profile.protected || profile.gateway !== undefined;
}

/**
 * Full command lines of this process's ancestors, nearest first, via `ps`.
 * Throws when `ps` cannot be run or yields nothing, so the guard fails closed.
 */
export function processAncestors(startPid: number = process.pid, maxDepth = 16): string[] {
  const ps = (pid: number, fields: string): string =>
    execFileSync("ps", ["-o", fields, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const lines: string[] = [];
  let pid = Number(ps(startPid, "ppid=")); // throws when ps is missing or fails
  if (!Number.isInteger(pid)) throw new Error("process check unavailable");
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    const m = /^(\d+)\s+(.*)$/.exec(ps(pid, "ppid=,args="));
    if (!m) break;
    lines.push(m[2] ?? "");
    pid = Number(m[1]);
  }
  if (lines.length === 0) throw new Error("process check unavailable");
  return lines;
}

const AGENT_NAMES = new Set([
  "claude",
  "claude-code",
  "codex",
  "gemini",
  "gemini-cli",
  "cursor-agent",
  "aider",
  "cline",
  "opencode",
  "goose",
]);

/** Whether a process command line (or bare name) looks like a coding-agent CLI. */
export function isAgentProcess(commandLine: string): boolean {
  return commandLine
    .split(/[\s/\\]+/)
    .filter((t) => t !== "")
    .some((t) => AGENT_NAMES.has(t.toLowerCase().replace(/\.(c|m)?js$/, "")));
}

/** Throws a neutral error when the session may not read personal data. */
export function assertHumanSession(input: GuardInput): void {
  if (!needsGuard(input.profile)) return;
  const refuse = (detail = ""): never => {
    throw new Error(`This command is not available in this session.${detail}`);
  };
  if (!input.stdinIsTTY || !input.stdoutIsTTY) refuse();
  if (agentMarkers(input.env).length > 0) refuse();
  let ancestors: string[];
  try {
    ancestors = (input.ancestors ?? (() => processAncestors()))();
  } catch {
    return refuse(" The process check could not run.");
  }
  if (ancestors.some(isAgentProcess)) refuse();
}
