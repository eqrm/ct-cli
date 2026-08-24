/**
 * What `ct` offers the shell when Tab is pressed (#132).
 *
 * The shell hook installed by `ct completion <shell>` is a stub: on every Tab it
 * hands the command line back to this process, and this module answers. Nothing is
 * baked into a generated script, so the candidates are always exactly what the
 * Commander tree in this build declares — and they can be *dynamic*, which a static
 * script structurally cannot be: real environment names out of `ct.envs.json`, real
 * keys out of the state file, real paths out of the working directory.
 *
 * Everything here is pure command-tree introspection plus the offline sources in
 * `./sources.js`; see that module for the never-contact-ChurchTools, never-throw,
 * never-hang guarantees.
 */
import type { Argument, Command, Option } from "commander";
import { defaultEnvStatePath, resolveEnvsPath } from "../env/envs.js";
import { resolveStatePath } from "../state/state.js";
import { envNames, envStatePath, paths, resourceTypes, stateKeys } from "./sources.js";

/** Where the cursor is: the resolved command plus the words already typed for it. */
interface Position {
  /** The deepest subcommand the typed words resolve to. */
  command: Command;
  /** Full path of that command, e.g. `ct state rm`. */
  path: string;
  /** Positional words typed for `command` so far. */
  positionals: string[];
  /** Values of the value-taking options typed so far, keyed by long flag. */
  options: Map<string, string>;
}

/** A value slot whose candidates come from a local file rather than the command tree. */
type DynamicSource = (position: Position, partial: string) => Promise<string[]> | string[];

/**
 * Positional arguments whose values live in a local file, keyed by `<command path>
 * <argument name>`. Keeping this a table rather than sprinkling special cases through
 * the walker keeps the dynamic surface reviewable in one place.
 */
const DYNAMIC_ARGUMENTS: Record<string, DynamicSource> = {
  "ct adopt type": () => resourceTypes(),
  "ct state rm type": () => resourceTypes(),
  // `ct state rm <type> <key>` refuses a key belonging to another type, so the type
  // already typed narrows the keys — completing into a guaranteed error helps nobody.
  "ct state rm key": async (position) => stateKeys(await statePathFor(position), position.positionals[0]),
};

/**
 * The state file the typed `--state`/`--env` words point at, with the same precedence
 * the commands use (`prepareEnv` → `resolveStatePath`): explicit `--state`, then
 * `CT_STATE`, then the env profile's own `state` field, then the `ct-state.<env>.json`
 * convention. Reading the profile's override matters — a repo that sets it would
 * otherwise be offered the keys of a state file it does not use.
 */
async function statePathFor(position: Position): Promise<string> {
  const env = position.options.get("--env");
  const declared = env ? await envStatePath(resolveEnvsPath(), env) : undefined;
  return resolveStatePath(
    position.options.get("--state"),
    process.env,
    env ? (declared ?? defaultEnvStatePath(env)) : undefined,
  );
}

function takesValue(option: Option): boolean {
  return option.required || option.optional;
}

function visibleOptions(command: Command): Option[] {
  return command.createHelp().visibleOptions(command);
}

function flagsOf(option: Option): string[] {
  return [option.short, option.long].filter((flag): flag is string => Boolean(flag));
}

function findOption(command: Command, flag: string): Option | undefined {
  return visibleOptions(command).find((option) => flagsOf(option).includes(flag));
}

function findSubcommand(command: Command, word: string): Command | undefined {
  return command.commands.find((child) => child.name() === word || child.aliases().includes(word));
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let node: Command | null = command; node; node = node.parent) names.unshift(node.name());
  return names.join(" ");
}

/**
 * Replay the typed words against the command tree.
 *
 * Unknown words are positionals, known subcommand names descend (and reset the
 * positional count), and a value-taking option swallows the word after it so that
 * `ct plan --env dev <TAB>` completes a positional rather than treating `dev` as one.
 */
function walk(program: Command, words: string[]): Position {
  let command = program;
  let positionals: string[] = [];
  const options = new Map<string, string>();

  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (word.startsWith("-")) {
      const split = word.indexOf("=");
      const flag = split === -1 ? word : word.slice(0, split);
      const option = findOption(command, flag) ?? findOption(program, flag);
      if (!option || !takesValue(option)) continue;
      const value = split === -1 ? words[++i] : word.slice(split + 1);
      if (option.long && value !== undefined) options.set(option.long, value);
      continue;
    }
    const child = findSubcommand(command, word);
    if (child) {
      command = child;
      positionals = [];
    } else {
      positionals.push(word);
    }
  }

  return { command, path: commandPath(command), positionals, options };
}

/**
 * The kind of value an option or argument wants, inferred from its placeholder and
 * description. Commander has no "this is a path" metadata, and every path-taking flag
 * in this CLI says so in its own help text (`--state <path>`, `--backup-dir <dir>`),
 * so the help text is the metadata.
 */
function pathKind(name: string, description: string): "file" | "directory" | undefined {
  const hint = `${name} ${description}`.toLowerCase();
  if (/\b(dir|directory|folder)\b/.test(hint)) return "directory";
  if (/\b(path|file|filename)\b/.test(hint)) return "file";
  return undefined;
}

/** The placeholder inside an option's flags, e.g. `path` for `-s, --state <path>`. */
function placeholder(option: Option): string {
  return option.flags.match(/[<[]([^>\]]+)[>\]]/)?.[1]?.replace(/\.{3}$/, "") ?? "value";
}

async function optionValues(option: Option, position: Position, partial: string): Promise<string[]> {
  if (option.argChoices?.length) return [...option.argChoices];
  // The one flag every command shares, and the reason runtime completion is worth it:
  // these are the environments this config repo actually defines.
  if (option.long === "--env") return envNames(resolveEnvsPath());
  const kind = pathKind(placeholder(option), option.description);
  return kind ? paths(partial, kind) : [];
}

async function argumentValues(position: Position, partial: string): Promise<string[]> {
  const args = position.command.registeredArguments;
  const argument: Argument | undefined =
    args[position.positionals.length] ?? (args.at(-1)?.variadic ? args.at(-1) : undefined);
  if (!argument) return [];
  if (argument.argChoices?.length) return [...argument.argChoices];
  const dynamic = DYNAMIC_ARGUMENTS[`${position.path} ${argument.name()}`];
  if (dynamic) return dynamic(position, partial);
  const kind = pathKind(argument.name(), argument.description);
  return kind ? paths(partial, kind) : [];
}

/** The option that the word before the cursor is still waiting for a value for, if any. */
function pendingOption(program: Command, position: Position, previous: string): Option | undefined {
  if (!previous.startsWith("-") || previous.includes("=")) return undefined;
  const option = findOption(position.command, previous) ?? findOption(program, previous);
  return option && takesValue(option) ? option : undefined;
}

/**
 * Candidates for the word being typed.
 *
 * `words` are the words already completed (including the program name); `partial` is
 * the word under the cursor, or `""` when the cursor sits after a space. The shells
 * do the prefix filtering themselves, so the full candidate set for the position is
 * returned — `partial` is only consulted where the candidates depend on it (paths).
 */
export async function completionCandidates(
  program: Command,
  words: string[],
  partial: string,
): Promise<string[]> {
  const position = walk(program, words.slice(1));

  const pending = pendingOption(program, position, words.at(-1) ?? "");
  if (pending) return optionValues(pending, position, partial);

  if (partial.startsWith("-")) return visibleOptions(position.command).flatMap(flagsOf);

  const subcommands = position.command
    .createHelp()
    .visibleCommands(position.command)
    .map((child) => child.name());
  return [...subcommands, ...(await argumentValues(position, partial))];
}

/**
 * Split a shell command line into the completed words plus the word under the cursor.
 *
 * `fragment` is the shell's index of the word under the cursor. It is what locates the
 * cursor at all: `line` is the whole buffer, so it also holds whatever the user has
 * typed *after* the cursor, and a trailing space in it says nothing about where the
 * cursor sits. Splitting at `fragment` is therefore what makes Tab in the middle of a
 * line complete the word it is actually on.
 *
 * The index is trustworthy in zsh and fish. bash's hook derives it from `COMP_CWORD`
 * minus a fudge for colons, and `COMP_WORDBREAKS` breaks on more than colons (`=`, `:`
 * after the cursor), so it can come in inflated past the end of the line. That case is
 * detectable — the index points past the last token — and falls back to the shape of
 * the line itself, which is what the previous behaviour did for every line.
 */
export function splitCompletionLine(line: string, fragment: number): { words: string[]; partial: string } {
  const tokens = line.split(/\s+/).filter(Boolean);
  if (fragment >= 0 && fragment < tokens.length) {
    return { words: tokens.slice(0, fragment), partial: tokens[fragment] ?? "" };
  }
  if (tokens.length === 0 || /\s$/.test(line)) return { words: tokens, partial: "" };
  return { words: tokens.slice(0, -1), partial: tokens.at(-1) ?? "" };
}
