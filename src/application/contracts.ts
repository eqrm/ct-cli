/** JSON-compatible values used at the application/adapter boundary. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type OperationName =
  | "plan"
  | "apply"
  | "coverage"
  | "adopt"
  | "unadopt"
  | "use"
  | "unuse"
  | "ownership"
  | "state"
  | "refresh"
  | "destroy"
  | "auth";

/** Common project selection accepted by CLI and, later, HTTP adapters. */
export interface ProjectRequest {
  cwd?: string;
  configPath?: string;
  statePath?: string;
  environment?: string;
}

/** Public, non-secret project context resolved before an operation starts. */
export interface ResolvedProjectInfo {
  cwd: string;
  /** Absolute paths used by operations. */
  configPath: string;
  statePath: string;
  environmentsPath: string;
  /** Effective flag/env/default spelling retained for byte-compatible CLI messages. */
  configDisplayPath: string;
  stateDisplayPath: string;
  environment: string | null;
  protected: boolean;
  host: string;
}

export interface CtWarning {
  code: string;
  message: string;
  details?: Record<string, JsonValue>;
}

export interface OperationResult<T> {
  operation: OperationName;
  project: ResolvedProjectInfo;
  value: T;
  warnings: CtWarning[];
}

/**
 * One completed unit of work, reported the moment it happens.
 *
 * Every long-running operation emits these as it goes instead of only returning them at the end:
 * a `ct destroy` that dies halfway through must still have said which resources it already
 * deleted, and a fan-out caution has to reach the operator BEFORE the fan-out runs (#156 review).
 */
export interface OperationOutcomeEvent {
  /** `ok` reads as a success line, `note` as neutral information, `failed` as an error. */
  status: "ok" | "note" | "failed";
  message: string;
}

export type OperationEvent =
  | { type: "phase-started"; phase: string }
  | { type: "resource-reading"; resourceType: string; key: string }
  | { type: "resource-created"; resourceType: string; key: string; id: number }
  | { type: "resource-updated"; resourceType: string; key: string; id: number }
  | { type: "resource-destroyed"; resourceType: string; key: string; id: number }
  | { type: "backup-written"; path: string }
  | { type: "warning"; warning: CtWarning }
  | { type: "outcome"; outcome: OperationOutcomeEvent };
