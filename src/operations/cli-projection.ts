import type { Command } from "commander";
import { adoptCommand } from "../commands/adopt.js";
import { applyCommand } from "../commands/apply.js";
import { authCommand } from "../commands/auth.js";
import { completionCommand } from "../commands/completion.js";
import { coverageCommand } from "../commands/coverage.js";
import { destroyCommand } from "../commands/destroy.js";
import { environmentCommand } from "../commands/environment.js";
import { getCommand } from "../commands/get.js";
import { initCommand } from "../commands/init.js";
import { inputCommand } from "../commands/input.js";
import { ownershipCommand } from "../commands/ownership.js";
import { permissionsCommand } from "../commands/permissions.js";
import { planCommand } from "../commands/plan.js";
import { refreshCommand } from "../commands/refresh.js";
import { unadoptCommand, unuseCommand } from "../commands/release.js";
import { reportCommand } from "../commands/report.js";
import { stateCommand } from "../commands/state.js";
import { serverCommand } from "../commands/server.js";
import { useCommand } from "../commands/use.js";
import { cliRootNames, type OperationDefinition } from "./catalog.js";

const factories: Record<string, () => Command> = {
  init: initCommand,
  auth: authCommand,
  input: inputCommand,
  environment: environmentCommand,
  get: getCommand,
  adopt: adoptCommand,
  unadopt: unadoptCommand,
  use: useCommand,
  unuse: unuseCommand,
  ownership: ownershipCommand,
  state: stateCommand,
  coverage: coverageCommand,
  permissions: permissionsCommand,
  report: reportCommand,
  refresh: refreshCommand,
  plan: planCommand,
  apply: applyCommand,
  destroy: destroyCommand,
  completion: completionCommand,
  server: serverCommand,
};

/** Build the root command tree by enumerating the same catalog used by HTTP and OpenAPI. */
export function buildCliProjection(catalog: readonly OperationDefinition[]): Command[] {
  const roots = cliRootNames(catalog);
  return roots.map((root) => {
    const factory = factories[root];
    if (!factory) throw new Error(`Operation catalog has no Commander projection factory for ${root}.`);
    return factory();
  });
}
