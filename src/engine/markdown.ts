/**
 * Plain-language Markdown projection of the same structured resource and
 * permission plans used by terminal and JSON output. This module is deliberately
 * pure: it performs no IO, fetches no ChurchTools data and never recomputes a
 * plan action.
 */
import type { FieldChange, FieldChangeSource, Plan, PlanAction, PlanItem } from "./types.js";
import type { PermissionPlanItem } from "../permissions/plan.js";
import type { GrantTuple } from "../permissions/grants.js";
import { CATALOG } from "../permissions/catalog.js";
import { refLabel } from "../resolve/refs.js";

export const PLAN_MARKDOWN_LOCALES = ["de-DE", "en"] as const;
export type PlanMarkdownLocale = (typeof PLAN_MARKDOWN_LOCALES)[number];

export interface MarkdownPlanContext {
  environment?: string | null;
  host: string;
  churchToolsVersion?: string | null;
  configPath: string;
  stateHost: string;
  /** Injected by tests/automation when byte-identical output is required. */
  generatedAt?: Date;
  locale?: PlanMarkdownLocale;
  /** Informational catalog/portability warnings already produced by the shared planning pipeline. */
  warnings?: string[];
  /** Fetch failures make the report incomplete and block apply. */
  fetchErrors?: string[];
}

interface Copy {
  title: string;
  planOnly: string;
  context: string;
  environment: string;
  host: string;
  churchToolsVersion: string;
  config: string;
  stateHost: string;
  generatedAt: string;
  summary: string;
  result: string;
  count: string;
  create: string;
  update: string;
  delete: string;
  noop: string;
  resourceTypes: string;
  resourceType: string;
  permissions: string;
  grants: string;
  revocations: string;
  preserved: string;
  changes: string;
  creates: string;
  updates: string;
  deleteCandidates: string;
  field: string;
  before: string;
  after: string;
  reason: string;
  configReason: string;
  driftReason: string;
  bothReason: string;
  drift: string;
  noChanges: string;
  deleteSafety: string;
  incompleteTitle: string;
  incompleteText: string;
  warnings: string;
  review: string;
  checklist: string[];
  appendix: string;
  logicalKey: string;
  id: string;
  action: string;
  note: string;
  details: string;
  unknown: string;
  none: string;
  pending: string;
  domain: string;
  right: string;
  scope: string;
  effect: string;
  permissionPreserved: string;
  automaticGroup: string;
  status: string;
  rules: string;
}

const COPY: Record<PlanMarkdownLocale, Copy> = {
  "de-DE": {
    title: "ChurchTools-Änderungsplan",
    planOnly:
      "Dieser Bericht beschreibt nur den Plan. Es wurde noch nichts in ChurchTools angelegt oder geändert.",
    context: "Kontext",
    environment: "Umgebung",
    host: "ChurchTools-Instanz",
    churchToolsVersion: "ChurchTools-Version",
    config: "Konfiguration",
    stateHost: "Instanz des State",
    generatedAt: "Erstellt am",
    summary: "Zusammenfassung",
    result: "Ergebnis",
    count: "Anzahl",
    create: "Neu anlegen",
    update: "Ändern",
    delete: "Löschkandidaten",
    noop: "Unverändert",
    resourceTypes: "Ressourcen nach Typ",
    resourceType: "Ressourcentyp",
    permissions: "Berechtigungen",
    grants: "Zu erteilen",
    revocations: "Zu entziehen",
    preserved: "Bewusst unangetastet",
    changes: "Geplante Änderungen",
    creates: "Neue Ressourcen",
    updates: "Geänderte Ressourcen",
    deleteCandidates: "Aus der Konfiguration entfernte Ressourcen",
    field: "Feld",
    before: "Bisher",
    after: "Geplant",
    reason: "Grund",
    configReason: "Konfiguration wurde geändert",
    driftReason: "Manuelle Änderung in ChurchTools wird zurückgeführt",
    bothReason: "Konfiguration und ChurchTools wurden unabhängig geändert",
    drift: "Erkannte manuelle Änderungen",
    noChanges:
      "Es sind keine Änderungen erforderlich. Der gewünschte Zustand stimmt mit ChurchTools überein.",
    deleteSafety:
      "`ct apply` löscht diese Ressourcen **nicht**. Eine tatsächliche Löschung ist nur über den separaten Befehl `ct destroy` möglich.",
    incompleteTitle: "Unvollständiger Plan",
    incompleteText:
      "Mindestens eine Ressource konnte nicht gelesen werden. Der Bericht ist deshalb nicht vollständig und darf nicht als Freigabe für `apply` verwendet werden.",
    warnings: "Warnungen",
    review: "Prüfung vor dem Anwenden",
    checklist: [
      "Stimmen Zielumgebung, Host und State-Datei überein?",
      "Sind alle neuen und geänderten Ressourcen fachlich gewollt?",
      "Sind Berechtigungsentzüge und Löschkandidaten ausdrücklich geprüft?",
      "Ist der Plan vollständig und sind alle Warnungen geklärt?",
      "Erst danach `ct apply -e <umgebung>` ausführen.",
    ],
    appendix: "Technischer Anhang",
    logicalKey: "Logischer Schlüssel",
    id: "ChurchTools-ID",
    action: "Aktion",
    note: "Hinweis",
    details: "Technische Details",
    unknown: "unbekannt",
    none: "keine",
    pending: "wird beim Anwenden erzeugt",
    domain: "Bereich",
    right: "Recht",
    scope: "Geltungsbereich",
    effect: "Auswirkung",
    permissionPreserved: "wird nicht verwaltet und bleibt erhalten",
    automaticGroup: "Automatische Gruppe",
    status: "Status",
    rules: "Regeln",
  },
  en: {
    title: "ChurchTools change plan",
    planOnly: "This report describes the plan only. Nothing has been created or changed in ChurchTools.",
    context: "Context",
    environment: "Environment",
    host: "ChurchTools instance",
    churchToolsVersion: "ChurchTools version",
    config: "Configuration",
    stateHost: "State instance",
    generatedAt: "Generated at",
    summary: "Summary",
    result: "Result",
    count: "Count",
    create: "Create",
    update: "Update",
    delete: "Delete candidates",
    noop: "Unchanged",
    resourceTypes: "Resources by type",
    resourceType: "Resource type",
    permissions: "Permissions",
    grants: "To grant",
    revocations: "To revoke",
    preserved: "Deliberately preserved",
    changes: "Planned changes",
    creates: "New resources",
    updates: "Updated resources",
    deleteCandidates: "Resources removed from configuration",
    field: "Field",
    before: "Before",
    after: "Planned",
    reason: "Reason",
    configReason: "Configuration changed",
    driftReason: "Manual ChurchTools change will be reverted",
    bothReason: "Configuration and ChurchTools changed independently",
    drift: "Detected manual changes",
    noChanges: "No changes are required. Desired state matches ChurchTools.",
    deleteSafety:
      "`ct apply` does **not** delete these resources. Actual deletion is only available through the separate `ct destroy` command.",
    incompleteTitle: "Incomplete plan",
    incompleteText:
      "At least one resource could not be read. This report is incomplete and must not be used to approve `apply`.",
    warnings: "Warnings",
    review: "Review before applying",
    checklist: [
      "Do environment, host and state file identify the same target?",
      "Are all new and updated resources intended?",
      "Were permission revocations and delete candidates explicitly reviewed?",
      "Is the plan complete and have all warnings been resolved?",
      "Only then run `ct apply -e <environment>`.",
    ],
    appendix: "Technical appendix",
    logicalKey: "Logical key",
    id: "ChurchTools ID",
    action: "Action",
    note: "Note",
    details: "Technical details",
    unknown: "unknown",
    none: "none",
    pending: "created during apply",
    domain: "Domain",
    right: "Right",
    scope: "Scope",
    effect: "Effect",
    permissionPreserved: "not managed and left untouched",
    automaticGroup: "Automatic group",
    status: "Status",
    rules: "Rules",
  },
};

const TYPE_LABELS: Record<PlanMarkdownLocale, Record<string, string>> = {
  "de-DE": {
    campus: "Campus",
    group: "Gruppe",
    "group-type": "Gruppentyp",
    "age-group": "Altersgruppe",
    "target-group": "Zielgruppe",
    "relationship-type": "Beziehungstyp",
    "person-status": "Personenstatus",
    department: "Bereich",
    "security-level": "Sicherheitsstufe",
    "group-role": "Gruppenrolle",
  },
  en: {
    campus: "Campus",
    group: "Group",
    "group-type": "Group type",
    "age-group": "Age group",
    "target-group": "Target group",
    "relationship-type": "Relationship type",
    "person-status": "Person status",
    department: "Department",
    "security-level": "Security level",
    "group-role": "Group role",
  },
};

const FIELD_LABELS: Record<PlanMarkdownLocale, Record<string, string>> = {
  "de-DE": {
    name: "Name",
    nameTranslated: "Übersetzter Name",
    shorty: "Kurzname",
    sortKey: "Sortierung",
    campusId: "Campus",
    groupTypeId: "Gruppentyp",
    groupStatusId: "Gruppenstatus",
    securityLevelId: "Sicherheitsstufe",
    parents: "Übergeordnete Gruppen",
    dynamic: "Automatische Gruppe",
    type: "Typ",
    isMember: "Mitgliedsstatus",
    isSearchable: "Suchbar",
  },
  en: {
    name: "Name",
    nameTranslated: "Translated name",
    shorty: "Short name",
    sortKey: "Sort order",
    campusId: "Campus",
    groupTypeId: "Group type",
    groupStatusId: "Group status",
    securityLevelId: "Security level",
    parents: "Parent groups",
    dynamic: "Automatic group",
    type: "Type",
    isMember: "Member status",
    isSearchable: "Searchable",
  },
};

const ACTION_LABELS: Record<PlanMarkdownLocale, Record<PlanAction, string>> = {
  "de-DE": { create: "anlegen", update: "ändern", delete: "Löschkandidat", "no-op": "unverändert" },
  en: { create: "create", update: "update", delete: "delete candidate", "no-op": "unchanged" },
};

const DOMAIN_LABELS: Record<PlanMarkdownLocale, Record<string, string>> = {
  "de-DE": { group_role: "Gruppenrolle", group_type_role: "Gruppentyp-Rolle", status: "Status" },
  en: { group_role: "Group role", group_type_role: "Group-type role", status: "Status" },
};

const DYNAMIC_STATUS: Record<PlanMarkdownLocale, Record<string, string>> = {
  "de-DE": {
    active: "automatisch aktiv",
    manual: "manuell auszuführen",
    inactive: "pausiert",
    none: "keine Automatik",
  },
  en: { active: "active automatically", manual: "run manually", inactive: "paused", none: "no automation" },
};

const MEMBER_FIELD_TYPE: Record<PlanMarkdownLocale, Record<string, string>> = {
  "de-DE": {
    checkbox: "Ja/Nein",
    multiselect: "Mehrfachauswahl",
    select: "Auswahl",
    text: "Kurzer Text",
    textarea: "Langer Text",
  },
  en: {
    checkbox: "Yes/No",
    multiselect: "Multiple choice",
    select: "Choice",
    text: "Short text",
    textarea: "Long text",
  },
};

const SECRET_KEY = /(?:token|secret|password|credential|authorization|cookie)/i;

function sanitize(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const childKey of Object.keys(value as Record<string, unknown>).sort()) {
      out[childKey] = sanitize((value as Record<string, unknown>)[childKey], childKey);
    }
    return out;
  }
  return value;
}

export function redactPlanReportSecrets(value: string): string {
  return value
    .replace(/([?&](?:login_)?token=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(sanitize(value));
}

/** Escape user-controlled text for both Markdown tables and prose. */
export function escapeMarkdown(value: unknown): string {
  return redactPlanReportSecrets(String(value ?? ""))
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/([*_<>#])/g, "\\$1")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replace(/`/g, "&#96;")
    .replace(/\r?\n/g, "<br>");
}

function typeLabel(type: string, locale: PlanMarkdownLocale): string {
  return TYPE_LABELS[locale][type] ?? type;
}

function fieldLabel(field: string, locale: PlanMarkdownLocale): string {
  return FIELD_LABELS[locale][field] ?? field;
}

function sourceLabel(source: FieldChangeSource | undefined, copy: Copy): string {
  if (source === "drift") return copy.driftReason;
  if (source === "config+drift") return copy.bothReason;
  return copy.configReason;
}

function valueText(value: unknown, copy: Copy): string {
  if (value === undefined) return copy.none;
  if (value !== null && typeof value === "object" && "__pendingRef" in value) {
    return `${refLabel((value as { __pendingRef: Parameters<typeof refLabel>[0] }).__pendingRef)} (${copy.pending})`;
  }
  if (Array.isArray(value)) return value.length > 0 ? value.map((v) => stableJson(v)).join(", ") : copy.none;
  return stableJson(value);
}

function dynamicText(value: unknown, copy: Copy): string | null {
  if (value === null || typeof value !== "object") return null;
  const dynamic = value as Record<string, unknown>;
  if (!("status" in dynamic) && !("ruleset" in dynamic)) return null;
  const ruleset = dynamic.ruleset;
  let rules: string;
  if (ruleset && typeof ruleset === "object" && "ref" in ruleset) {
    rules = String((ruleset as Record<string, unknown>).ref);
  } else if (ruleset && typeof ruleset === "object") {
    const count = Object.keys(ruleset as Record<string, unknown>).length;
    rules = `${count} ${copy.rules.toLocaleLowerCase()}`;
  } else {
    rules = copy.none;
  }
  return `${copy.automaticGroup}: ${copy.status} ${String(dynamic.status ?? copy.unknown)}, ${copy.rules} ${rules}`;
}

function renderValue(value: unknown, field: string, copy: Copy): string {
  if (SECRET_KEY.test(field)) return escapeMarkdown("[REDACTED]");
  const semantic = field === "dynamic" ? dynamicText(value, copy) : null;
  return escapeMarkdown(semantic ?? valueText(value, copy));
}

function table(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
}

function resourceHeading(item: PlanItem, locale: PlanMarkdownLocale): string {
  const name = item.displayName || item.key;
  const technical = `${item.type}.${item.key}${item.id === null ? "" : ` · #${item.id}`}`;
  return `### ${escapeMarkdown(name)} — ${escapeMarkdown(typeLabel(item.type, locale))} (${escapeMarkdown(technical)})`;
}

function changeRows(changes: FieldChange[], locale: PlanMarkdownLocale, copy: Copy): string[][] {
  return changes.map((change) => [
    escapeMarkdown(fieldLabel(change.field, locale)),
    renderValue(change.from, change.field, copy),
    renderValue(change.to, change.field, copy),
    escapeMarkdown(sourceLabel(change.source, copy)),
  ]);
}

function changedFields(item: PlanItem): Record<string, unknown> {
  return Object.fromEntries(item.changes.map((change) => [change.field, change.to]));
}

function itemNames(plan: Plan): Map<string, string> {
  return new Map(plan.items.map((item) => [item.key, item.displayName || item.key]));
}

function findRulesetFilters(node: unknown, variable: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const value of node) findRulesetFilters(value, variable, found);
    return found;
  }
  if (node === null || typeof node !== "object") return found;
  for (const [operator, expression] of Object.entries(node as Record<string, unknown>)) {
    if (
      (operator === "==" || operator === "oneof") &&
      Array.isArray(expression) &&
      expression[0] !== null &&
      typeof expression[0] === "object" &&
      (expression[0] as Record<string, unknown>).var === variable
    ) {
      found.push(expression[1]);
    }
    findRulesetFilters(expression, variable, found);
  }
  return found;
}

function flattenUnique(values: unknown[]): unknown[] {
  return [...new Set(values.flat(Number.POSITIVE_INFINITY).map((value) => stableJson(value)))].map(
    (encoded) => {
      try {
        return JSON.parse(encoded) as unknown;
      } catch {
        return encoded;
      }
    },
  );
}

function dynamicDetails(dynamic: unknown, plan: Plan, locale: PlanMarkdownLocale): string[] {
  if (dynamic === null || typeof dynamic !== "object") return [];
  const value = dynamic as Record<string, unknown>;
  if (value.ruleset === null || typeof value.ruleset !== "object") return [];
  const ruleset = value.ruleset as Record<string, unknown>;
  const names = itemNames(plan);
  const groupNamesById = new Map(
    plan.items
      .filter((item) => item.type === "group" && item.id !== null)
      .map((item) => [item.id as number, item.displayName || item.key]),
  );
  const sourceIds = flattenUnique(findRulesetFilters(ruleset.query, "ctgroup.id"));
  const sourceNames = flattenUnique(findRulesetFilters(ruleset.query, "ctgroup.name"));
  const process = ruleset.process as Record<string, unknown> | undefined;
  const queryOnly = (process?.queryResultOnly as Record<string, unknown> | undefined)?.none as
    Record<string, unknown> | undefined;
  const groupAndQuery = (process?.groupAndQueryResult as Record<string, unknown> | undefined)?.active as
    Record<string, unknown> | undefined;
  const membership = (queryOnly?.handleMembership ?? groupAndQuery?.handleMembership) as
    Record<string, unknown> | undefined;
  const lines: string[] = [];
  if (sourceIds.length > 0) {
    const resolved = sourceIds.map((entry) => {
      if (typeof entry === "number") return groupNamesById.get(entry) ?? `ChurchTools group #${entry}`;
      if (entry && typeof entry === "object") {
        const pending = (entry as Record<string, unknown>).__pendingRef ?? entry;
        if (pending && typeof pending === "object") {
          const key = (pending as Record<string, unknown>).key;
          if (typeof key === "string") return names.get(key) ?? key;
        }
      }
      return stableJson(entry);
    });
    lines.push(
      locale === "de-DE"
        ? `Quelle der Teilnehmenden: ${resolved.join(", ")}`
        : `Participant source: ${resolved.join(", ")}`,
    );
  }
  if (sourceNames.length > 0) {
    lines.push(
      locale === "de-DE"
        ? `Ausgewertete Gruppen: ${sourceNames.map(stableJson).join(", ")}`
        : `Evaluated groups: ${sourceNames.map(stableJson).join(", ")}`,
    );
  }
  if (membership?.groupTypeRoleId !== undefined) {
    lines.push(
      locale === "de-DE"
        ? `Neue Mitgliedschaft verwendet die aufgelöste Rollen-ID ${stableJson(membership.groupTypeRoleId)}.`
        : `New membership uses resolved role ID ${stableJson(membership.groupTypeRoleId)}.`,
    );
  }
  if (membership?.groupMemberFields && typeof membership.groupMemberFields === "object") {
    const assignments = Object.entries(membership.groupMemberFields as Record<string, unknown>)
      .map(([key, entry]) => `${key} = ${stableJson(entry)}`)
      .join(", ");
    lines.push(
      locale === "de-DE"
        ? `Automatisch gesetzte Gruppenfelder: ${assignments}`
        : `Automatically assigned group fields: ${assignments}`,
    );
  }
  const groupOnly = (process?.groupOnly as Record<string, unknown> | undefined)?.active as
    Record<string, unknown> | undefined;
  const groupOnlyMembership = groupOnly?.handleMembership as Record<string, unknown> | undefined;
  if (groupOnlyMembership?.groupMemberStatus === "none") {
    lines.push(
      locale === "de-DE"
        ? "Aktive Mitgliedschaften werden beendet, wenn eine Person die Auswahlbedingungen nicht mehr erfüllt."
        : "Active memberships end when a person no longer matches the selection criteria.",
    );
  }
  return lines;
}

function memberFieldsFor(group: PlanItem, plan: Plan): PlanItem[] {
  if (group.type !== "group") return [];
  return plan.items.filter(
    (item) =>
      item.action === "create" &&
      item.type === "group-member-field" &&
      (item.key === group.key || item.key.startsWith(`${group.key}::`)),
  );
}

function renderGroupOverview(item: PlanItem, plan: Plan, locale: PlanMarkdownLocale, copy: Copy): string[] {
  if (item.type !== "group" || item.action !== "create") return [];
  const fields = changedFields(item);
  const names = itemNames(plan);
  const groupTypeNames = new Map(
    plan.items
      .filter((entry) => entry.type === "group-type" && entry.id !== null)
      .map((entry) => [entry.id as number, entry.displayName || entry.key]),
  );
  const parents = Array.isArray(fields.parents)
    ? fields.parents.map((key) => names.get(String(key)) ?? String(key))
    : [];
  const dynamic = fields.dynamic;
  const groupType = groupTypeNames.get(Number(fields.groupTypeId)) ?? copy.unknown;
  const ownedFields = memberFieldsFor(item, plan);
  const lines = [
    `- ${locale === "de-DE" ? "Technischer Schlüssel" : "Technical key"}: \`${escapeMarkdown(item.key)}\``,
    `- ${locale === "de-DE" ? "Gruppentyp" : "Group type"}: ${escapeMarkdown(groupType)}${fields.groupTypeId === undefined ? "" : ` (#${escapeMarkdown(fields.groupTypeId)})`}`,
    `- ${locale === "de-DE" ? "Gruppenstatus" : "Group status"}: ${escapeMarkdown(fields.groupStatusId ?? copy.unknown)}`,
    `- ${locale === "de-DE" ? "Übergeordnete Gruppe(n)" : "Parent group(s)"}: ${escapeMarkdown(parents.length > 0 ? parents.join(", ") : copy.none)}`,
    `- ${locale === "de-DE" ? "Neue Gruppenmitgliedsfelder" : "New group member fields"}: ${ownedFields.length}`,
    `- ${copy.automaticGroup}: ${escapeMarkdown(DYNAMIC_STATUS[locale][String((dynamic as Record<string, unknown> | undefined)?.status)] ?? copy.none)}`,
    "",
  ];
  const details = dynamicDetails(dynamic, plan, locale);
  if (details.length > 0) {
    lines.push(locale === "de-DE" ? "Was die Automatik macht:" : "What the automation does:", "");
    for (const detail of details) lines.push(`- ${escapeMarkdown(detail)}`);
    lines.push("");
  }
  if (ownedFields.length > 0) {
    lines.push(
      ...table(
        [
          locale === "de-DE" ? "Feld" : "Field",
          locale === "de-DE" ? "Technischer Name" : "Technical name",
          locale === "de-DE" ? "Art" : "Type",
          locale === "de-DE" ? "Standardwert" : "Default",
          locale === "de-DE" ? "Auswahlwerte" : "Options",
          locale === "de-DE" ? "Anmeldung" : "Registration",
          locale === "de-DE" ? "Sicherheitsstufe" : "Security level",
        ].map(escapeMarkdown),
        ownedFields.map((field) => {
          const value = changedFields(field);
          const registration = value.useInRegistrationForm
            ? value.requiredInRegistrationForm
              ? locale === "de-DE"
                ? "sichtbar, Pflichtfeld"
                : "visible, required"
              : locale === "de-DE"
                ? "sichtbar, freiwillig"
                : "visible, optional"
            : locale === "de-DE"
              ? "nicht im Formular"
              : "not in form";
          const options = Array.isArray(value.options)
            ? value.options.map((option) => stableJson(option)).join(", ")
            : copy.none;
          return [
            value.name,
            value.referenceName,
            MEMBER_FIELD_TYPE[locale][String(value.fieldTypeCode)] ?? value.fieldTypeCode,
            value.defaultValue ?? copy.none,
            options,
            registration,
            value.securityLevel ?? copy.unknown,
          ].map(escapeMarkdown);
        }),
      ),
      "",
    );
  }
  return lines;
}

function renderResourceSection(
  title: string,
  items: PlanItem[],
  plan: Plan,
  locale: PlanMarkdownLocale,
  copy: Copy,
): string[] {
  if (items.length === 0) return [];
  const lines = [`## ${title}`, ""];
  for (const item of items) {
    lines.push(resourceHeading(item, locale), "");
    lines.push(...renderGroupOverview(item, plan, locale, copy));
    if (item.note === "recreate") {
      lines.push(
        locale === "de-DE"
          ? "Die Ressource fehlt in ChurchTools und wird mit einer neuen ID wieder angelegt."
          : "The resource is missing in ChurchTools and will be recreated with a new ID.",
        "",
      );
    }
    if (item.changes.length > 0 && item.type !== "group") {
      lines.push(
        ...table(
          [copy.field, copy.before, copy.after, copy.reason].map(escapeMarkdown),
          changeRows(item.changes, locale, copy),
        ),
        "",
      );
    }
  }
  return lines;
}

function catalogRight(authId: number): { technical: string; description: string } | null {
  const found = Object.entries(CATALOG).find(([, entry]) => entry.authId === authId);
  return found ? { technical: found[0], description: found[1].desc } : null;
}

function tupleRight(tuple: GrantTuple): string {
  const right = catalogRight(tuple.authId);
  return right ? `${right.description} (${right.technical}, #${tuple.authId})` : `authId #${tuple.authId}`;
}

function tupleScope(tuple: GrantTuple, copy: Copy): string {
  if (tuple.pending && tuple.scopeKey) return `${tuple.scopeKey} (${copy.pending})`;
  if (tuple.scopeKey) return tuple.scopeKey;
  return tuple.dataId.length > 0 ? tuple.dataId.map((id) => `#${id}`).join(", ") : copy.none;
}

function permissionDomain(item: PermissionPlanItem, locale: PlanMarkdownLocale, copy: Copy): string {
  const label = DOMAIN_LABELS[locale][item.domainType] ?? item.domainType;
  const id = item.pendingDomain ? `${refLabel(item.pendingDomain)} (${copy.pending})` : `#${item.domainId}`;
  return `${label} ${item.key} (${id})`;
}

function permissionCounts(items: PermissionPlanItem[]): {
  grants: number;
  revocations: number;
  preserved: number;
} {
  return {
    grants: items.reduce((sum, item) => sum + item.diff.toPut.length, 0),
    revocations: items.reduce((sum, item) => sum + item.diff.toDelete.length, 0),
    preserved: items.reduce(
      (sum, item) => sum + item.diff.preserved.length + item.diff.preservedUnknown.length,
      0,
    ),
  };
}

function renderPermissions(items: PermissionPlanItem[], locale: PlanMarkdownLocale, copy: Copy): string[] {
  const visible = items.filter(
    (item) =>
      item.diff.toPut.length +
        item.diff.toDelete.length +
        item.diff.preserved.length +
        item.diff.preservedUnknown.length >
      0,
  );
  if (visible.length === 0) return [];
  const lines = [`## ${copy.permissions}`, ""];
  for (const item of visible) {
    lines.push(`### ${escapeMarkdown(permissionDomain(item, locale, copy))}`, "");
    const rows: string[][] = [];
    for (const tuple of item.diff.toPut) {
      rows.push([
        escapeMarkdown(tupleRight(tuple)),
        escapeMarkdown(tupleScope(tuple, copy)),
        escapeMarkdown(copy.grants),
      ]);
    }
    for (const tuple of item.diff.toDelete) {
      rows.push([
        escapeMarkdown(tupleRight(tuple)),
        escapeMarkdown(tupleScope(tuple, copy)),
        escapeMarkdown(copy.revocations),
      ]);
    }
    for (const tuple of [...item.diff.preservedUnknown, ...item.diff.preserved]) {
      rows.push([
        escapeMarkdown(tupleRight(tuple)),
        escapeMarkdown(tupleScope(tuple, copy)),
        escapeMarkdown(copy.permissionPreserved),
      ]);
    }
    lines.push(...table([copy.right, copy.scope, copy.effect].map(escapeMarkdown), rows), "");
  }
  return lines;
}

function renderDrift(plan: Plan, locale: PlanMarkdownLocale, copy: Copy): string[] {
  const items = plan.items.filter((item) => (item.drift?.length ?? 0) > 0);
  if (items.length === 0) return [];
  const lines = [`## ${copy.drift}`, ""];
  for (const item of items) {
    lines.push(resourceHeading(item, locale), "");
    lines.push(
      ...table(
        [copy.field, copy.before, copy.after].map(escapeMarkdown),
        (item.drift ?? []).map((change) => [
          escapeMarkdown(fieldLabel(change.field, locale)),
          renderValue(change.from, change.field, copy),
          renderValue(change.to, change.field, copy),
        ]),
      ),
      "",
    );
  }
  return lines;
}

function renderAppendix(plan: Plan, locale: PlanMarkdownLocale, copy: Copy): string[] {
  const rows = plan.items.map((item) => {
    const safeChanges = (changes: FieldChange[] | undefined): FieldChange[] | undefined =>
      changes?.map((change) =>
        SECRET_KEY.test(change.field)
          ? { ...change, from: change.from === undefined ? undefined : "[REDACTED]", to: "[REDACTED]" }
          : change,
      );
    const technical = {
      changes: safeChanges(item.changes),
      drift: safeChanges(item.drift),
      preventDestroy: item.preventDestroy,
      detail: item.detail,
    };
    return [
      escapeMarkdown(typeLabel(item.type, locale)),
      escapeMarkdown(item.key),
      escapeMarkdown(item.id ?? "—"),
      escapeMarkdown(ACTION_LABELS[locale][item.action]),
      escapeMarkdown(item.note ?? "—"),
      escapeMarkdown(stableJson(technical)),
    ];
  });
  return [
    `## ${copy.appendix}`,
    "",
    ...table(
      [copy.resourceType, copy.logicalKey, copy.id, copy.action, copy.note, copy.details].map(escapeMarkdown),
      rows,
    ),
    "",
  ];
}

export function renderPlanMarkdown(
  plan: Plan,
  permissions: PermissionPlanItem[],
  context: MarkdownPlanContext,
): string {
  const locale = context.locale ?? "de-DE";
  const copy = COPY[locale];
  const generatedAt = context.generatedAt ?? new Date();
  const counts = { create: 0, update: 0, delete: 0, "no-op": 0 } satisfies Record<PlanAction, number>;
  for (const item of plan.items) counts[item.action]++;
  const perms = permissionCounts(permissions);
  const incompleteItems = plan.items.filter((item) => item.note === "fetch-failed");
  const fetchErrors = context.fetchErrors ?? [];
  const incomplete = incompleteItems.length > 0 || fetchErrors.length > 0;
  const warnings = [...new Set((context.warnings ?? []).map(redactPlanReportSecrets))];

  const lines: string[] = [
    `# ${copy.title}`,
    "",
    locale === "de-DE"
      ? `Erstellt am ${new Intl.DateTimeFormat("de-DE", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(generatedAt)} UTC.`
      : `Generated ${new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(generatedAt)} UTC.`,
    "",
    `> ${copy.planOnly}`,
    "",
    `## ${copy.context}`,
    "",
    ...table(
      [copy.result, copy.details].map(escapeMarkdown),
      [
        [copy.environment, context.environment ?? copy.none],
        [copy.host, context.host],
        [copy.churchToolsVersion, context.churchToolsVersion ?? copy.unknown],
        [copy.config, context.configPath],
        [copy.stateHost, context.stateHost],
      ].map(([key, value]) => [escapeMarkdown(key), escapeMarkdown(value)]),
    ),
    "",
    `## ${copy.summary}`,
    "",
  ];

  const hasChanges = counts.create + counts.update + counts.delete + perms.grants + perms.revocations > 0;
  lines.push(
    `- ${copy.create}: ${counts.create}`,
    `- ${copy.update}: ${counts.update}`,
    `- ${copy.delete}: ${counts.delete}`,
    `- ${copy.noop}: ${counts["no-op"]}`,
    `- ${copy.grants}: ${perms.grants}`,
    `- ${copy.revocations}: ${perms.revocations}`,
    `- ${copy.preserved}: ${perms.preserved}`,
    "",
  );
  if (!hasChanges && !incomplete) {
    lines.push(`**${copy.result}:** ${copy.noChanges}`, "");
  } else if (counts.update === 0 && counts.delete === 0 && perms.revocations === 0 && !incomplete) {
    lines.push(
      locale === "de-DE"
        ? "**Ergebnis:** Der Plan ergänzt ausschließlich neue Ressourcen oder Berechtigungen. Bestehende Ressourcen werden nicht verändert oder gelöscht."
        : "**Result:** The plan only adds resources or permissions. Existing resources are not changed or deleted.",
      "",
    );
  }

  const byType = new Map<string, Record<PlanAction, number>>();
  for (const item of plan.items) {
    const current = byType.get(item.type) ?? { create: 0, update: 0, delete: 0, "no-op": 0 };
    current[item.action]++;
    byType.set(item.type, current);
  }
  if (byType.size > 0) {
    lines.push(
      `### ${copy.resourceTypes}`,
      "",
      ...table(
        [copy.resourceType, copy.create, copy.update, copy.delete, copy.noop].map(escapeMarkdown),
        [...byType.entries()]
          .sort(([a], [b]) => typeLabel(a, locale).localeCompare(typeLabel(b, locale), locale))
          .map(([type, value]) => [
            escapeMarkdown(typeLabel(type, locale)),
            String(value.create),
            String(value.update),
            String(value.delete),
            String(value["no-op"]),
          ]),
      ),
      "",
    );
  }

  lines.push(
    ...renderResourceSection(
      copy.creates,
      plan.items.filter(
        (item) =>
          item.action === "create" &&
          (item.type !== "group-member-field" ||
            !plan.items.some((group) => memberFieldsFor(group, plan).includes(item))),
      ),
      plan,
      locale,
      copy,
    ),
    ...renderResourceSection(
      copy.updates,
      plan.items.filter((item) => item.action === "update"),
      plan,
      locale,
      copy,
    ),
  );

  const deleteCandidates = plan.items.filter((item) => item.action === "delete");
  if (deleteCandidates.length > 0) {
    lines.push(`## ${copy.deleteCandidates}`, "", copy.deleteSafety, "");
    for (const item of deleteCandidates) lines.push(resourceHeading(item, locale), "");
  }

  lines.push(...renderDrift(plan, locale, copy), ...renderPermissions(permissions, locale, copy));

  if (incomplete) {
    lines.push(`## ⚠️ ${copy.incompleteTitle}`, "", copy.incompleteText, "");
    const entries = [
      ...incompleteItems.map((item) => `${item.type}.${item.key}: ${item.detail ?? copy.unknown}`),
      ...fetchErrors,
    ];
    for (const entry of [...new Set(entries)])
      lines.push(`- ${escapeMarkdown(redactPlanReportSecrets(entry))}`);
    lines.push("");
  }

  if (warnings.length > 0) {
    lines.push(`## ${copy.warnings}`, "");
    for (const warning of warnings) lines.push(`- ${escapeMarkdown(warning)}`);
    lines.push("");
  }

  lines.push(`## ${copy.review}`, "");
  for (const item of copy.checklist) lines.push(`- [ ] ${item}`);
  lines.push("", ...renderAppendix(plan, locale, copy));

  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
