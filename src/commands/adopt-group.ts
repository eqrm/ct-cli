import { Command } from "commander";
import { runAdoptGroups } from "../application/operations/adopt-group.js";
import { cliObserver } from "./observer.js";
import { info, out, success } from "../ui.js";

interface AdoptGroupOptions {
  key?: string;
  state?: string;
  env?: string;
  dryRun?: boolean;
  type?: string;
  childrenOf?: string;
  withDynamic?: boolean;
  withMemberFields?: boolean;
  rekey?: boolean;
  portableRulesets?: boolean;
  strictRulesets?: boolean;
}

export function adoptGroupCommand(): Command {
  return new Command("group")
    .description(
      "Adopt one or more groups: `ct adopt group <id...>`, or a filtered bulk form via " +
        "--type / --children-of. See --with-dynamic to also capture a dynamic group's ruleset.",
    )
    .argument("[ids...]", "one or more ChurchTools group ids")
    .option("-k, --key <key>", "logical key (only valid when exactly one group is resolved)")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--rekey", "let a re-adoption change an already-managed group's logical key")
    .option("--dry-run", "preview the config entries and state changes without writing")
    .option("--type <groupTypeIdOrKey>", "adopt every group of this group type")
    .option("--children-of <idOrKey>", "adopt a group's full hierarchy subtree")
    .option("--with-dynamic", "capture dynamic rulesets to rulesets/<key>.json")
    .option("--with-member-fields", "capture portable group-scoped member-field definitions")
    .option("--portable-rulesets", "rewrite managed entity ids into portable logical refs")
    .option("--no-portable-rulesets", "capture rulesets verbatim with host-specific numeric ids")
    .option("--strict-rulesets", "refuse rulesets that retain a host-specific id")
    .action(async (ids: string[], _localOpts: AdoptGroupOptions, command: Command) => {
      const opts = command.optsWithGlobals() as AdoptGroupOptions;
      // Warnings print as they are produced: a `--strict-rulesets` throw halfway through a
      // subtree used to take the record of every already-adopted group with it (#156 review).
      const result = await runAdoptGroups(
        {
          ids,
          key: opts.key,
          statePath: opts.state,
          environment: opts.env,
          dryRun: opts.dryRun,
          groupType: opts.type,
          childrenOf: opts.childrenOf,
          withDynamic: opts.withDynamic,
          withMemberFields: opts.withMemberFields,
          rekey: opts.rekey,
          portableRulesets: opts.portableRulesets,
          strictRulesets: opts.strictRulesets,
        },
        { observer: cliObserver() },
      );
      if (result.value.noMatches) {
        info("No groups matched — nothing to adopt.");
        return;
      }
      if (result.value.dryRun) {
        const payload = result.value.groups.map((group) => ({
          key: group.key,
          type: "group",
          id: group.id,
          fields: group.fields,
          config: group.snippet,
        }));
        info(
          payload.length === 1
            ? `Would adopt group #${payload[0]!.id} as "${payload[0]!.key}". Generated config entry:`
            : `Would adopt ${payload.length} groups. Generated config entries:`,
        );
        out(payload.length === 1 ? payload[0] : payload);
        return;
      }
      for (const group of result.value.groups) {
        // action null: an id-map group (#202) — only its ruleset was captured, no state was written.
        if (group.action === null) {
          success(`Captured the ruleset of group #${group.id} ("${group.key}", id map) — no state written`);
          continue;
        }
        success(
          `${group.action === "created" ? "Adopted" : "Updated"} group #${group.id} as "${group.key}" → ${result.project.stateDisplayPath}`,
        );
      }
      if (result.value.configBlock === null) return;
      info(result.value.groups.length === 1 ? "Config entry:" : "Config entries (paste into your config):");
      process.stdout.write(`${result.value.configBlock}\n`);
    });
}
