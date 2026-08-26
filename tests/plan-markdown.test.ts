import { describe, expect, it } from "vitest";
import { planOutputTargets, parsePlanLocale } from "../src/commands/plan.js";
import { escapeMarkdown, redactPlanReportSecrets, renderPlanMarkdown } from "../src/engine/markdown.js";
import type { Plan } from "../src/engine/types.js";
import type { PermissionPlanItem } from "../src/permissions/plan.js";

const context = {
  environment: "test",
  host: "https://example.church.tools",
  churchToolsVersion: "3.135.2",
  configPath: "ct.config.ts",
  stateHost: "https://example.church.tools",
  generatedAt: new Date("2026-08-24T12:34:00.000Z"),
  locale: "de-DE" as const,
};

const permission = (overrides: Partial<PermissionPlanItem> = {}): PermissionPlanItem => ({
  key: "team_lead",
  domainType: "group_type_role",
  domainId: 8,
  diff: {
    toPut: [{ authId: 1113, dataId: [], type: "grant" }],
    toDelete: [{ authId: 1104, dataId: [42], type: "grant" }],
    preserved: [{ authId: 100, dataId: [], type: "revoke" }],
    preservedUnknown: [{ authId: 113, dataId: [7], type: "grant" }],
  },
  ...overrides,
});

describe("plan output targets", () => {
  it("keeps the default and --json stdout behavior backward compatible", () => {
    expect(planOutputTargets({})).toEqual([{ format: "text", path: undefined }]);
    expect(planOutputTargets({ json: true })).toEqual([{ format: "json", path: undefined }]);
  });

  it("derives deterministic sidecar names while computing the plan only once", () => {
    expect(
      planOutputTargets({
        format: ["text", "json", "markdown"],
        outputBase: "reports/plan-prod",
      }),
    ).toEqual([
      { format: "text", path: "reports/plan-prod.txt" },
      { format: "json", path: "reports/plan-prod.json" },
      { format: "markdown", path: "reports/plan-prod.md" },
    ]);
    expect(planOutputTargets({ format: ["markdown"], outputBase: "reports/plan.md" })).toEqual([
      { format: "markdown", path: "reports/plan.md" },
    ]);
  });

  it("rejects ambiguous or unsupported output selections before planning", () => {
    expect(() => planOutputTargets({ json: true, format: ["markdown"] })).toThrow("cannot be combined");
    expect(() => planOutputTargets({ format: ["text", "markdown"] })).toThrow("require --output-base");
    expect(() => planOutputTargets({ outputBase: "plan" })).toThrow("requires");
    expect(() => planOutputTargets({ format: ["pdf"] })).toThrow("Unknown plan format");
    expect(() => parsePlanLocale("fr")).toThrow("Available locales");
  });
});

describe("plain-language Markdown plan", () => {
  it("renders the proven consumer-report structure for an unchanged plan", () => {
    const output = renderPlanMarkdown({ items: [] }, [], context);
    expect(output).toContain("# ChurchTools-Änderungsplan");
    expect(output).toContain("> Dieser Bericht beschreibt nur den Plan.");
    expect(output).toContain("## Zusammenfassung");
    expect(output).toContain("**Ergebnis:** Es sind keine Änderungen erforderlich");
    expect(output).toContain("## Prüfung vor dem Anwenden");
  });

  it("explains mixed resources, automation, member fields, drift, deletes and permissions", () => {
    const plan: Plan = {
      items: [
        {
          type: "group-type",
          key: "team",
          displayName: "Team",
          id: 2,
          action: "no-op",
          changes: [],
        },
        {
          type: "group",
          key: "source",
          displayName: "Quellgruppe",
          id: 42,
          action: "no-op",
          changes: [],
        },
        {
          type: "group",
          key: "new_team",
          displayName: "Neues | Team",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Neues | Team", source: "config" },
            { field: "groupTypeId", from: undefined, to: 2, source: "config" },
            { field: "groupStatusId", from: undefined, to: 1, source: "config" },
            { field: "parents", from: undefined, to: ["source"], source: "config" },
            {
              field: "dynamic",
              from: undefined,
              to: {
                status: "active",
                ruleset: {
                  query: { "==": [{ var: "ctgroup.id" }, 42] },
                  process: { queryResultOnly: { none: { handleMembership: { groupTypeRoleId: 9 } } } },
                },
              },
              source: "config",
            },
          ],
        },
        {
          type: "group-member-field",
          key: "new_team::consent",
          displayName: "Einwilligung",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Einwilligung", source: "config" },
            { field: "referenceName", from: undefined, to: "consent", source: "config" },
            { field: "fieldTypeCode", from: undefined, to: "checkbox", source: "config" },
            { field: "useInRegistrationForm", from: undefined, to: true, source: "config" },
            { field: "requiredInRegistrationForm", from: undefined, to: true, source: "config" },
            { field: "securityLevel", from: undefined, to: 2, source: "config" },
          ],
        },
        {
          type: "campus",
          key: "mainz",
          displayName: "Mainz",
          id: 1,
          action: "update",
          changes: [{ field: "name", from: "MZ", to: "Mainz", source: "config+drift" }],
          drift: [{ field: "name", from: "Mainz alt", to: "MZ" }],
        },
        {
          type: "future-type",
          key: "old_entry",
          displayName: "Alt `intern`",
          id: 99,
          action: "delete",
          changes: [],
        },
      ],
    };

    const output = renderPlanMarkdown(plan, [permission()], context);
    expect(output).toContain("## Neue Ressourcen");
    expect(output).toContain("### Neues \\| Team");
    expect(output).toContain("Quelle der Teilnehmenden: Quellgruppe");
    expect(output).toContain("Neue Mitgliedschaft verwendet die aufgelöste Rollen-ID 9");
    expect(output).toContain("Einwilligung");
    expect(output).toContain("sichtbar, Pflichtfeld");
    expect(output).toContain("Konfiguration und ChurchTools wurden unabhängig geändert");
    expect(output).toContain("## Erkannte manuelle Änderungen");
    expect(output).toContain("`ct apply` löscht diese Ressourcen **nicht**");
    expect(output).toContain("## Berechtigungen");
    expect(output).toContain("Zu entziehen");
    expect(output).toContain("wird nicht verwaltet und bleibt erhalten");
    expect(output).toContain("future-type");
    expect(output).toContain("Alt &#96;intern&#96;");
    expect(output).not.toContain("[object Object]");
  });

  it("marks incomplete plans as blocking and includes deduplicated warnings", () => {
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "broken",
          displayName: "Nicht lesbar",
          id: 7,
          action: "no-op",
          changes: [],
          note: "fetch-failed",
          detail: "HTTP 500",
        },
      ],
    };
    const output = renderPlanMarkdown(plan, [], {
      ...context,
      warnings: ["Katalog veraltet", "Katalog veraltet"],
      fetchErrors: ["group.broken: Serverfehler"],
    });
    expect(output).toContain("## ⚠️ Unvollständiger Plan");
    expect(output).toContain("darf nicht als Freigabe");
    expect(output.match(/Katalog veraltet/g)).toHaveLength(1);
  });

  it("escapes Markdown and redacts likely secrets in every fallback", () => {
    expect(escapeMarkdown("A|B\n`x` #1")).toBe("A\\|B<br>&#96;x&#96; \\#1");
    expect(redactPlanReportSecrets("https://user:pass@example.test?a=1&login_token=secret")).toBe(
      "https://[REDACTED]@example.test?a=1&login_token=[REDACTED]",
    );
    const output = renderPlanMarkdown(
      {
        items: [
          {
            type: "future",
            key: "secret",
            id: null,
            action: "create",
            changes: [
              { field: "apiToken", from: undefined, to: "must-not-leak" },
              { field: "payload", from: undefined, to: { password: "hidden", visible: "ok" } },
            ],
          },
        ],
      },
      [],
      context,
    );
    expect(output).not.toContain("must-not-leak");
    expect(output).not.toContain("hidden");
    expect(output).toContain("REDACTED");
  });

  it("shows the before/after table for a group update instead of a bare heading", () => {
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "youth",
          displayName: "Jugend",
          id: 7,
          action: "update",
          changes: [{ field: "name", from: "Jugendkreis", to: "Jugend", source: "config" }],
        },
      ],
    };
    const output = renderPlanMarkdown(plan, [], context);
    expect(output).toContain("## Geänderte Ressourcen");
    expect(output).toContain("### Jugend");
    expect(output).toContain("Jugendkreis");
    expect(output).toContain("| Feld |");
  });

  it("renders a new member field on an existing group in its own section", () => {
    const plan: Plan = {
      items: [
        { type: "group", key: "youth", displayName: "Jugend", id: 7, action: "no-op", changes: [] },
        {
          type: "group-member-field",
          key: "youth::consent",
          displayName: "Einwilligung",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Einwilligung", source: "config" },
            { field: "referenceName", from: undefined, to: "consent", source: "config" },
          ],
        },
      ],
    };
    const output = renderPlanMarkdown(plan, [], context);
    expect(output).toContain("## Neue Ressourcen");
    expect(output).toContain("Einwilligung");
  });

  it("names a group type that is created in the same run instead of printing the raw ref", () => {
    const plan: Plan = {
      items: [
        { type: "group-type", key: "team", displayName: "Team", id: null, action: "create", changes: [] },
        {
          type: "group",
          key: "new_team",
          displayName: "Neues Team",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Neues Team", source: "config" },
            {
              field: "groupTypeId",
              from: undefined,
              to: { __pendingRef: { kind: "group-type", key: "team" } },
              source: "config",
            },
          ],
        },
      ],
    };
    const output = renderPlanMarkdown(plan, [], context);
    expect(output).toContain("Gruppentyp: Team (wird beim Anwenden erzeugt)");
    expect(output).not.toContain("[object Object]");
    expect(output).not.toContain("unbekannt (#");
  });

  it("is byte-identical for a fixed clock and supports English without changing plan semantics", () => {
    const plan: Plan = {
      items: [{ type: "campus", key: "mainz", displayName: "Mainz", id: 1, action: "no-op", changes: [] }],
    };
    expect(renderPlanMarkdown(plan, [], context)).toBe(renderPlanMarkdown(plan, [], context));
    const english = renderPlanMarkdown(plan, [], { ...context, locale: "en" });
    expect(english).toContain("# ChurchTools change plan");
    expect(english).toContain("No changes are required");
  });
});
