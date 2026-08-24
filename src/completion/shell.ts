/**
 * The shell side of tab completion (#132).
 *
 * `ct` does not generate a completion script. It installs a ~15-line hook — supplied
 * by [omelette](https://github.com/f/omelette), not written here — that calls `ct`
 * back on every Tab with the current command line, and answers with the candidates
 * from {@link completionCandidates}. Two consequences are the whole point of doing it
 * this way:
 *
 * - The per-shell syntax (zsh `compdef`/`compadd`, bash `complete`/`compgen`, fish
 *   `complete -a`) lives in the library. The only dialect this repo writes itself is
 *   {@link BASH_COMPLETION_FALLBACKS}, and only because omelette's bash branch depends
 *   on a package stock macOS bash does not ship.
 * - The candidates are computed live, so they follow the command tree of the binary
 *   that is actually installed and can include things a static script could never
 *   know — the environments in *this* `ct.envs.json`, the keys in *this* state file.
 *
 * omelette was picked over `@pnpm/tabtab` because it has no dependencies and inlines
 * its hooks as strings, whereas tabtab reads its templates off disk at runtime: in
 * the `bun build --compile` binaries this project releases, that resolves to the
 * build machine's `node_modules` and fails with ENOENT on every user's machine.
 *
 * omelette is effectively frozen — last release 0.4.17 in September 2021, last commit
 * January 2022 — which is accepted deliberately. It is ~350 lines of MIT-licensed,
 * dependency-free CommonJS whose entire job is emitting three static hook strings, so
 * the realistic failure mode is "never gains a feature", not "breaks". If it ever does
 * break, vendoring it into this repo is an afternoon's work and the licence allows it.
 * The tests here cover the hook shape per shell, so a regression surfaces in CI.
 */
import type { Command } from "commander";
import omelette from "omelette";
import { completionCandidates, splitCompletionLine } from "./candidates.js";

export const COMPLETION_SHELLS = ["zsh", "bash", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/** The plumbing flag omelette's hooks pass when the shell is asking for candidates. */
const COMPGEN_FLAG = "--compgen";

/** What omelette hands a `complete` handler. Narrower than `@types/omelette`, which
 *  does not model the two-argument `complete` event or a promise-returning reply. */
interface CompletionRequest {
  /** The full command line as the shell has it, e.g. `ct state rm ca`. */
  line: string;
  /** The shell's index of the word being completed. */
  fragment: number;
  reply: (words: string[] | Promise<string[]>) => void;
}

interface CompletionHook {
  onAsync(event: "complete", handler: (fragment: string, request: CompletionRequest) => void): void;
  init(): void;
  generateCompletionCode(): string;
  generateCompletionCodeFish(): string;
}

function hook(program: Command): CompletionHook {
  return omelette(program.name()) as unknown as CompletionHook;
}

/**
 * The one piece of shell dialect this repo does own.
 *
 * omelette's `complete`-based branch calls `_get_comp_words_by_ref` and
 * `__ltrim_colon_completions`, which ship with the `bash-completion` package rather
 * than with bash. Stock macOS bash (3.2, the one `~/.bash_profile` in the README gets
 * you) has neither, so without this every single Tab prints two `command not found`
 * lines into the command line — exactly the failure mode the rest of this module goes
 * out of its way to avoid. These stand-ins do what that one call site asks for and
 * nothing more, and they only ever define a name that is not already defined, so a
 * machine that does have bash-completion keeps the real ones.
 */
const BASH_COMPLETION_FALLBACKS = `### ct completion fallbacks - begin ###
if ! type compdef >/dev/null 2>&1 && type complete >/dev/null 2>&1; then
  if ! declare -F _get_comp_words_by_ref >/dev/null 2>&1; then
    _get_comp_words_by_ref() { cur=\${COMP_WORDS[COMP_CWORD]}; prev=\${COMP_WORDS[COMP_CWORD-1]}; }
  fi
  if ! declare -F __ltrim_colon_completions >/dev/null 2>&1; then
    __ltrim_colon_completions() { :; }
  fi
fi
### ct completion fallbacks - end ###`;

/** The hook to paste into a shell startup file. zsh and bash share one (it branches itself). */
export function completionScript(program: Command, shell: CompletionShell): string {
  const instance = hook(program);
  if (shell === "fish") return `${instance.generateCompletionCodeFish()}\n`;
  return `${BASH_COMPLETION_FALLBACKS}\n${instance.generateCompletionCode()}\n`;
}

/** True when this invocation is a shell asking for candidates rather than a user running a command. */
export function isCompletionRequest(argv: readonly string[]): boolean {
  return argv.includes(COMPGEN_FLAG);
}

/**
 * Answer one completion request and exit.
 *
 * A completion that errors is worse than one that offers nothing — a rejected promise
 * here would spill a stack trace into the user's command line — so failures collapse
 * to an empty candidate list. `reply` writes the candidates and exits the process.
 */
export function serveCompletionRequest(program: Command): void {
  const instance = hook(program);
  instance.onAsync("complete", (_fragment, request) => {
    const { words, partial } = splitCompletionLine(request.line, request.fragment);
    request.reply(completionCandidates(program, words, partial).catch(() => []));
  });
  instance.init();
}
