import type { ExternalResource } from "../state/state.js";

export const EXTERNAL_REASON_CODES = [
  "EXTERNAL_BINDING_MISSING",
  "EXTERNAL_BINDING_AMBIGUOUS",
  "EXTERNAL_IDENTITY_MISMATCH",
  "EXTERNAL_BINDING_STALE",
  "EXTERNAL_READ_FAILED",
] as const;

export type ExternalReasonCode = (typeof EXTERNAL_REASON_CODES)[number];

export interface ExternalCandidate {
  id: number;
  name: string;
  identity: Record<string, unknown>;
  display: Record<string, unknown>;
}

export interface IdentityDifference {
  field: string;
  expected: unknown;
  actual: unknown;
}

export interface ExternalDiagnosticContext {
  consumer?: string;
  cwd?: string;
  configPath?: string;
  statePath?: string;
  environment?: string | null;
  host: string;
}

export interface ExternalRemediation {
  description: string;
  command?: string;
}

export interface ExternalDiagnosticDetails {
  reason: ExternalReasonCode;
  type: string;
  key: string;
  site: string;
  context: ExternalDiagnosticContext;
  binding?: ExternalResource;
  candidates?: ExternalCandidate[];
  identityDiff?: IdentityDifference[];
  evidence: string[];
  consequence: string;
  remediation: ExternalRemediation[];
  verification: string;
}

function fieldBag(value: Record<string, unknown>): string {
  const entries = Object.entries(value);
  return entries.length === 0
    ? ""
    : ` · ${entries.map(([key, item]) => `${key}=${JSON.stringify(item)}`).join(", ")}`;
}

export function identityDifferences(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): IdentityDifference[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return keys
    .filter((field) => JSON.stringify(expected[field]) !== JSON.stringify(actual[field]))
    .map((field) => ({ field, expected: expected[field], actual: actual[field] }));
}

export function planVerification(environment?: string | null): string {
  return environment ? `ct plan --env ${environment}` : "ct plan";
}

export function useBindingCommand(
  type: string,
  id: number,
  key: string,
  environment?: string | null,
): string {
  return `ct use ${type} ${id} --key ${key}${environment ? ` --env ${environment}` : ""}`;
}

export function renderExternalDiagnostic(details: ExternalDiagnosticDetails): string {
  const { context } = details;
  const lines = [
    "External prerequisite is not available",
    "",
    `  resource:    ${details.type} ${JSON.stringify(details.key)}`,
    `  referenced:  ${details.site}`,
    `  consumer:    ${context.consumer ?? context.cwd ?? "current ct project"}`,
    `  owner:       ${details.binding?.owner ?? "unknown"}`,
    `  environment: ${context.environment ?? "default"}`,
    `  host:        ${context.host}`,
    "",
    "Evidence:",
    ...details.evidence.map((item) => `  - ${item}`),
  ];
  if (details.candidates?.length) {
    lines.push("", "Candidates:");
    for (const candidate of details.candidates) {
      lines.push(
        `  - #${candidate.id} ${JSON.stringify(candidate.name)}${fieldBag(candidate.identity)}${fieldBag(candidate.display)}`,
      );
    }
  }
  if (details.identityDiff?.length) {
    lines.push("", "Identity changes:");
    for (const diff of details.identityDiff) {
      lines.push(`  - ${diff.field}: ${JSON.stringify(diff.expected)} -> ${JSON.stringify(diff.actual)}`);
    }
  }
  lines.push("", `Consequence: ${details.consequence}`, "", "Next steps:");
  details.remediation.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.command ?? step.description}`);
    if (step.command && step.description) lines.push(`     ${step.description}`);
  });
  lines.push("", `Verification: ${details.verification}`);
  return lines.join("\n");
}

export class ExternalReferenceError extends Error {
  constructor(readonly details: ExternalDiagnosticDetails) {
    super(renderExternalDiagnostic(details));
    this.name = "ExternalReferenceError";
  }
}
