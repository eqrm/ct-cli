import { Command } from "commander";
import {
  discoverExternalCandidates,
  inspectExternalCandidate,
  runUseResource,
  type UseResourceResult,
} from "../application/operations/use.js";
import { CtApplicationError } from "../application/errors.js";
import { askVisible, confirm } from "../ui/prompt.js";
import { info, success, warn } from "../ui.js";

interface UseOptions {
  key?: string;
  owner?: string;
  state?: string;
  env?: string;
  yes?: boolean;
  dryRun?: boolean;
}

function candidateLine(candidate: {
  id: number;
  name: string;
  identity: Record<string, unknown>;
  display: Record<string, unknown>;
}): string {
  const details = Object.entries({ ...candidate.identity, ...candidate.display })
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
  return `#${candidate.id} ${JSON.stringify(candidate.name)}${details ? ` · ${details}` : ""}`;
}

async function bind(
  type: string,
  id: number,
  key: string,
  opts: UseOptions,
): Promise<UseResourceResult | null> {
  const request = {
    type,
    id,
    key,
    owner: opts.owner,
    statePath: opts.state,
    environment: opts.env,
    dryRun: opts.dryRun,
  };
  try {
    return await runUseResource(request);
  } catch (error) {
    if (!(error instanceof CtApplicationError) || error.code !== "EXTERNAL_CONFIRMATION_REQUIRED")
      throw error;
    warn(error.message);
    const accepted = await confirm("Accept this external binding change?", { assumeYes: opts.yes });
    if (!accepted) {
      info("Aborted — external state was not changed.");
      return null;
    }
    return runUseResource({ ...request, acceptChanges: true });
  }
}

export function useCommand(): Command {
  return new Command("use")
    .description("Bind an existing ChurchTools object as an external read-only prerequisite")
    .argument("<type>", "ct-cli resource type, e.g. campus | group | group-type")
    .argument("<selector>", "exact ChurchTools id, or an interactive fuzzy name search")
    .option("-k, --key <key>", "portable logical key (required for non-interactive use)")
    .option("--owner <project>", "optional owner-project coordination hint")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("-y, --yes", "accept an identity change or replacement without prompting")
    .option("--dry-run", "validate and report the binding without writing state")
    .action(async (type: string, selector: string, opts: UseOptions) => {
      const numeric = /^\d+$/.test(selector.trim());
      const interactive = Boolean(process.stdin.isTTY);
      if ((!numeric || !opts.key) && !interactive) {
        throw new Error(
          "Non-interactive use requires an exact numeric id and --key, e.g. `ct use group 4711 --key ojahr_fuzzies`.",
        );
      }

      let chosen;
      let suggestedKey: string | undefined;
      if (numeric) {
        const inspected = await inspectExternalCandidate({
          type,
          id: selector,
          statePath: opts.state,
          environment: opts.env,
        });
        chosen = inspected.value.candidate;
        suggestedKey = inspected.value.suggestedKey;
      } else {
        const discovered = await discoverExternalCandidates({
          type,
          search: selector,
          statePath: opts.state,
          environment: opts.env,
        });
        if (discovered.value.candidates.length === 0) {
          throw new Error(`No live ${type} matches ${JSON.stringify(selector)}.`);
        }
        info(`Matching ${type} candidates:`);
        discovered.value.candidates.forEach((candidate, index) =>
          info(`  ${index + 1}. ${candidateLine(candidate)}`),
        );
        const answer = (
          await askVisible(`Select candidate [1-${discovered.value.candidates.length}]: `)
        ).trim();
        const selected = answer === "" && discovered.value.candidates.length === 1 ? 1 : Number(answer);
        if (!Number.isInteger(selected) || selected < 1 || selected > discovered.value.candidates.length) {
          throw new Error("No valid candidate selected. External state was not changed.");
        }
        chosen = discovered.value.candidates[selected - 1]!;
        const inspected = await inspectExternalCandidate({
          type,
          id: chosen.id,
          statePath: opts.state,
          environment: opts.env,
        });
        chosen = inspected.value.candidate;
        suggestedKey = inspected.value.suggestedKey;
      }

      let key = opts.key?.trim();
      if (!key) {
        const proposal = suggestedKey!;
        const answer = (await askVisible(`Logical key [${proposal}]: `)).trim();
        key = answer || proposal;
      }
      const result = await bind(type, chosen.id, key, opts);
      if (!result) return;
      const { action, binding, written } = result.value;
      if (opts.dryRun) {
        info(`Would ${action} external ${type}.${binding.key} -> #${binding.id}; ChurchTools is read-only.`);
      } else if (action === "no-op") {
        success(`External ${type}.${binding.key} already binds #${binding.id}; state is byte-unchanged.`);
      } else {
        success(
          `${action}: external ${type}.${binding.key} -> #${binding.id} in ${result.project.stateDisplayPath}.`,
        );
      }
      if (written) info("ChurchTools was read for validation and was not written.");
    });
}
