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

const PLANNED: Planned[] = [
  { name: "plan", description: "Show the diff between desired state and ChurchTools", issue: "Phase 3 (#5)" },
  { name: "apply", description: "Apply the plan (idempotent, in dependency order)", issue: "Phase 4 (#6)" },
  { name: "destroy", description: "Explicitly remove managed resources (protected)", issue: "Phase 4 (#6)" },
];

export function plannedCommands(): Command[] {
  return PLANNED.map(({ name, description, issue }) =>
    new Command(name).description(`${description} [${issue}]`).action(() => {
      warn(`\`ct ${name}\` is not implemented yet — planned for ${issue}.`);
      process.exitCode = 2;
    }),
  );
}
