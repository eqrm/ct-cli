/**
 * Interactive confirmation. Dependencies (`isTTY`, `ask`) are injectable so the
 * prompts are testable without a real terminal. In production they default to
 * the process's TTY state and a readline question on stdin.
 */
import { createInterface } from "node:readline";

export interface PromptOptions {
  isTTY?: boolean;
  ask?: (question: string) => Promise<string>;
}

function realAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function ttyState(opts: PromptOptions): boolean {
  return opts.isTTY ?? Boolean(process.stdin.isTTY);
}

/** Yes/No confirmation. `assumeYes` skips the prompt (for `-y`/CI). */
export async function confirm(
  message: string,
  opts: PromptOptions & { assumeYes?: boolean } = {},
): Promise<boolean> {
  if (opts.assumeYes) {
    return true;
  }
  if (!ttyState(opts)) {
    return false;
  }
  const ask = opts.ask ?? realAsk;
  const answer = await ask(`${message} [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

/** Require the user to type `expected` exactly. `force` skips the prompt. */
export async function confirmTyped(
  expected: string,
  opts: PromptOptions & { force?: boolean } = {},
): Promise<boolean> {
  if (opts.force) {
    return true;
  }
  if (!ttyState(opts)) {
    return false;
  }
  const ask = opts.ask ?? realAsk;
  const answer = await ask(`Type "${expected}" to confirm: `);
  return answer.trim() === expected;
}
