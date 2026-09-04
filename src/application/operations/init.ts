import { initializeConfigRepository, type InitResult } from "../../init.js";

export interface InitWorkspaceRequest {
  directory: string;
  template?: string;
  host?: string;
  environment?: string;
  protected?: boolean;
  git?: boolean;
  yes?: boolean;
}

export interface InitWorkspaceResult {
  operation: "init";
  value: InitResult;
}

export interface InitWorkspaceDependencies {
  initialize?: typeof initializeConfigRepository;
  isTTY?: boolean;
  ask?: (question: string) => Promise<string>;
}

/** Non-interactive workspace initialization shared by CLI and HTTP adapters. */
export async function runInitWorkspace(
  request: InitWorkspaceRequest,
  dependencies: InitWorkspaceDependencies = {},
): Promise<InitWorkspaceResult> {
  const value = await (dependencies.initialize ?? initializeConfigRepository)(request.directory, {
    template: request.template,
    host: request.host,
    environment: request.environment,
    protected: request.protected,
    git: request.git,
    yes: request.yes,
    isTTY: dependencies.isTTY,
    ask: dependencies.ask,
  });
  return { operation: "init", value };
}
