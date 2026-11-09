/**
 * Personal-data guard for `ct dupes`.
 *
 * Against a protected (or unknown) environment the command only runs for a human at a terminal:
 * stdin and stdout must be TTYs, no coding-agent marker may be in the environment, and no
 * ancestor process may be a coding-agent CLI. There is deliberately no flag that skips this.
 */
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { EnvProfile } from "../env/envs.js";

export interface GuardInput {
  /** The selected profile, or null when no `--env` was given. */
  profile: Pick<EnvProfile, "protected" | "gateway"> | null;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  env: NodeJS.ProcessEnv;
  /** Names of this process's ancestors, nearest first. */
  ancestors?: () => string[];
}

/** Environment markers set by coding-agent CLIs. */
export function agentMarkers(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter(
    (k) => env[k] !== undefined && (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "AI_AGENT"),
  );
}

/** Whether this env holds data the guard protects. Unknown (no `--env`) counts as protected. */
export function needsGuard(profile: GuardInput["profile"]): boolean {
  return profile === null || profile.protected || profile.gateway !== undefined;
}

/** Ancestor process names via `ps`; empty when unavailable. */
export function processAncestors(startPid: number = process.pid, maxDepth = 16): string[] {
  const names: string[] = [];
  let pid = startPid;
  for (let i = 0; i < maxDepth && pid > 1; i++) {
    try {
      const line = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const m = /^(\d+)\s+(.*)$/.exec(line);
      if (!m) break;
      pid = Number(m[1]);
      const parent = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (parent) names.push(basename(parent));
    } catch {
      break;
    }
  }
  return names;
}

const AGENT_PROCESS = /^(claude|claude-code)$/i;

/** Throws a neutral error when the session may not read personal data. */
export function assertHumanSession(input: GuardInput): void {
  if (!needsGuard(input.profile)) return;
  const refuse = (): never => {
    throw new Error("This command is not available in this session.");
  };
  if (!input.stdinIsTTY || !input.stdoutIsTTY) refuse();
  if (agentMarkers(input.env).length > 0) refuse();
  const ancestors = (input.ancestors ?? (() => processAncestors()))();
  if (ancestors.some((n) => AGENT_PROCESS.test(n))) refuse();
}
