import { Command } from "commander";
import { warn } from "../ui.js";

/**
 * Declarative verbs are scaffolded here so the CLI surface is complete and
 * discoverable via `--help`, but each is gated until its phase lands.
 */
interface Planned {
  name: string;
  description: string;
  issue: string;
}

// apply/destroy landed in Phase 4; no verbs are gated at present.
const PLANNED: Planned[] = [];

export function plannedCommands(): Command[] {
  return PLANNED.map(({ name, description, issue }) =>
    new Command(name).description(`${description} [${issue}]`).action(() => {
      warn(`\`ct ${name}\` is not implemented yet — planned for ${issue}.`);
      process.exitCode = 2;
    }),
  );
}
