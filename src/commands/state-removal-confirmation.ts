import type { ResolvedProjectInfo } from "../application/contracts.js";
import { confirmTyped } from "../ui/prompt.js";

export interface StateRemovalConfirmationOptions {
  confirmEnv?: string;
  confirmKey?: string;
}

/**
 * State-only lifecycle changes use the same typed environment gate as protected
 * apply/destroy. Legacy projects without a named environment type the logical
 * key instead; automation supplies the exact value explicitly.
 */
export async function confirmStateRemoval(
  project: ResolvedProjectInfo,
  key: string,
  options: StateRemovalConfirmationOptions,
): Promise<boolean> {
  if (project.environment) {
    if (options.confirmEnv !== undefined) return options.confirmEnv === project.environment;
    return confirmTyped(project.environment);
  }
  if (options.confirmKey !== undefined) return options.confirmKey === key;
  return confirmTyped(key);
}
