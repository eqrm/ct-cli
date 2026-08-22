/**
 * Interactive confirmation. Dependencies (`isTTY`, `ask`) are injectable so the
 * prompts are testable without a real terminal. In production they default to
 * the process's TTY state and a readline question on stdin.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

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

export interface SecretPromptOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** Read a secret from the terminal without echoing its characters. */
export function askSecret(message: string, opts: SecretPromptOptions = {}): Promise<string> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({ input, output: mutedOutput, terminal: true });

  output.write(message);
  return new Promise<string>((resolve) => {
    rl.question("", (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer);
    });
  });
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

/**
 * Protected-environment gate (#22): applying or destroying against a protected env
 * ALWAYS requires typed confirmation of the environment name — there is NO
 * `force`/`assumeYes` escape here by design. For non-interactive/CI use, the
 * `--confirm-env <name>` flag (passed as `confirmFlag`) substitutes for the typed
 * input and must match `envName` exactly. On a non-TTY with no flag, this refuses.
 */
export async function confirmEnv(
  envName: string,
  opts: PromptOptions & { confirmFlag?: string } = {},
): Promise<boolean> {
  if (opts.confirmFlag !== undefined) {
    return opts.confirmFlag === envName;
  }
  if (!ttyState(opts)) {
    return false;
  }
  const ask = opts.ask ?? realAsk;
  const answer = await ask(`Protected environment "${envName}". Type the environment name to confirm: `);
  return answer.trim() === envName;
}
