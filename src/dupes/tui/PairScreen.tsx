/** Pair screen: modelled on ChurchTools' "Dubletten überprüfen" dialog. */
import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useState, type ReactElement } from "react";
import { CtApiError } from "../../api/ctClient.js";
import {
  executeMerge,
  formatValue,
  loadPair,
  markNotDuplicate,
  recoverUnrecordedMerge,
  type PairData,
  type ReviewDeps,
} from "../actions.js";
import {
  differs,
  setChoice,
  setDefaultEmail,
  toggleEmail,
  type EmailRow,
  type FieldRow,
  type MergeModel,
  type Side,
} from "../merge-model.js";
import { itemDiffers, setItemChoice, type MemberItem, type SharedGroup } from "../groups.js";
import type { StoredCandidate } from "../store.js";

export type PairOutcome = "merged" | "dismissed" | "skipped" | "back";

type Entry =
  | { kind: "field"; row: FieldRow }
  | { kind: "email"; row: EmailRow }
  | { kind: "group"; group: SharedGroup }
  | { kind: "member"; group: SharedGroup; row: MemberItem };

const entryId = (e: Entry): string =>
  e.kind === "field"
    ? `f:${e.row.key}`
    : e.kind === "email"
      ? `e:${e.row.address}`
      : e.kind === "group"
        ? `g:${e.group.id}`
        : `m:${e.group.id}:${e.row.key}`;

export function visibleEntries(
  model: MergeModel,
  showIdentical: boolean,
  shared: readonly SharedGroup[] = [],
): Entry[] {
  const out: Entry[] = [];
  for (const f of model.fields) if (showIdentical || differs(f)) out.push({ kind: "field", row: f });
  const emailsDiffer = model.emails.some((e) => !e.originalEntry || !e.duplicateEntry);
  if (showIdentical || emailsDiffer) for (const e of model.emails) out.push({ kind: "email", row: e });
  for (const g of shared) {
    out.push({ kind: "group", group: g });
    for (const i of g.items)
      if (showIdentical || itemDiffers(i)) out.push({ kind: "member", group: g, row: i });
  }
  return out;
}

/** What happens to a shared group, in one line. */
export function groupPlan(g: SharedGroup): string {
  if (g.dynamic) return `Auto-Gruppe: Duplikat wird entfernt`;
  const taken = g.items.filter((i) => i.choice === "duplicate" && itemDiffers(i)).map((i) => i.label);
  return taken.length === 0
    ? "Mitgliedschaft des Originals bleibt, Duplikat wird entfernt"
    : `Original übernimmt ${taken.join(", ")} vom Duplikat; Duplikat wird entfernt`;
}

const clip = (s: string, n: number): string =>
  s.length <= n ? s.padEnd(n) : `${s.slice(0, Math.max(0, n - 1))}…`;

function PersonCard(props: {
  title: string;
  color: "green" | "red";
  name: string;
  id: string;
  created: string;
  login: string;
}): ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={props.color}
      paddingX={1}
      flexGrow={1}
      flexBasis={0}
    >
      <Text bold color={props.color}>
        {props.title}
      </Text>
      <Text>{props.name || "(no name)"}</Text>
      <Text>ID: {props.id}</Text>
      <Text>Erstellt am: {props.created || "-"}</Text>
      <Text>Letzter Login: {props.login || "nie"}</Text>
    </Box>
  );
}

export function PairScreen(props: {
  deps: ReviewDeps;
  cand: StoredCandidate;
  onDone: (o: PairOutcome, note?: string) => void;
}): ReactElement {
  const { deps, cand, onDone } = props;
  const r = deps.redactor;
  const { stdout } = useStdout();
  const cols = stdout.columns ?? 100;
  const rowsAvail = stdout.rows ?? 30;

  const [dir, setDir] = useState<[number, number]>([Math.min(cand.a, cand.b), Math.max(cand.a, cand.b)]);
  const [pair, setPair] = useState<PairData | null>(null);
  const [model, setModel] = useState<MergeModel | null>(null);
  const [shared, setShared] = useState<SharedGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [showIdentical, setShowIdentical] = useState(false);
  const [mode, setMode] = useState<"table" | "confirm" | "busy" | "result">("table");
  const [message, setMessage] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<PairOutcome>("back");

  useEffect(() => {
    let live = true;
    setPair(null);
    setError(null);
    loadPair(deps, dir[0], dir[1]).then(
      (p) => {
        if (!live) return;
        setPair(p);
        setModel(p.model);
        setShared(p.shared);
        setCursor(0);
      },
      async (err: unknown) => {
        if (!live) return;
        if (err instanceof CtApiError && err.status === 404) {
          if (await recoverUnrecordedMerge(deps, cand.a, cand.b)) {
            setOutcome("merged");
            setMessage(["An earlier merge of this pair had not been recorded; recorded it now."]);
          } else {
            setOutcome("skipped");
            setMessage(["One of the two persons no longer exists."]);
          }
          setMode("result");
          return;
        }
        setError(`Could not load the pair${err instanceof CtApiError ? ` (HTTP ${err.status})` : ""}.`);
      },
    );
    return () => {
      live = false;
    };
  }, [dir]);

  const entries = pair && model ? visibleEntries(model, showIdentical, shared) : [];
  const current = entries[Math.min(cursor, Math.max(0, entries.length - 1))];

  const update = (f: (m: MergeModel) => MergeModel): void => setModel((m) => (m ? f(m) : m));

  useInput((input, key) => {
    if (mode === "busy") return;
    if (mode === "result") {
      onDone(outcome, message[0]);
      return;
    }
    if (mode === "confirm") {
      if (input === "y" || key.return) void doMerge();
      else if (input === "n" || key.escape) setMode("table");
      return;
    }
    if (key.escape) return onDone("back");
    if (error) return;
    if (!pair || !model) return;
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1));
    else if (key.downArrow) setCursor((c) => Math.min(entries.length - 1, c + 1));
    else if (key.pageUp) setCursor((c) => Math.max(0, c - 10));
    else if (key.pageDown) setCursor((c) => Math.min(entries.length - 1, c + 10));
    else if (input === "i") setShowIdentical((v) => !v);
    else if (input === "t") setDir(([a, b]) => [b, a]);
    else if (input === "s") onDone("skipped");
    else if (input === "n") void doNoDuplicate();
    else if (input === "m") setMode("confirm");
    else if (current?.kind === "field" && (key.leftArrow || key.rightArrow || input === "x")) {
      const side: Side = key.leftArrow ? "duplicate" : key.rightArrow ? "original" : "none";
      update((m) => setChoice(m, current.row.key, side));
    } else if (current?.kind === "member" && (key.leftArrow || key.rightArrow)) {
      const side: Side = key.leftArrow ? "duplicate" : "original";
      const g = current.group.id;
      const k = current.row.key;
      setShared((gs) => setItemChoice(gs, g, k, side));
    } else if (current?.kind === "email" && (input === " " || input === "x")) {
      update((m) => toggleEmail(m, current.row.address));
    } else if (current?.kind === "email" && input === "*") {
      update((m) => setDefaultEmail(m, current.row.address));
    }
  });

  async function doNoDuplicate(): Promise<void> {
    setMode("busy");
    const res = await markNotDuplicate(deps, dir[0], dir[1]);
    setOutcome("dismissed");
    setMessage([
      res.ok
        ? "Marked as not a duplicate in ChurchTools."
        : `The decision is saved locally, but ChurchTools did not accept the write-back${res.status ? ` (HTTP ${res.status})` : ""}.`,
    ]);
    setMode("result");
  }

  async function doMerge(): Promise<void> {
    if (!pair || !model) return;
    setMode("busy");
    const res = await executeMerge(deps, pair, model, shared);
    if (res.kind === "failed") {
      setOutcome("back");
      setMessage([
        res.stage === "reread"
          ? `Could not re-read the Original${res.status ? ` (HTTP ${res.status})` : ""}; nothing was changed.`
          : res.stage === "groups"
            ? `Gruppe ${res.groupId ?? "?"} konnte nicht vorbereitet werden${res.status ? ` (HTTP ${res.status})` : ""}; nicht zusammengeführt.${
                res.groupsDone && res.groupsDone.length > 0
                  ? ` Bereits erledigt (nicht zurückgenommen): Gruppen ${res.groupsDone.map((g) => g.groupId).join(", ")}.`
                  : ""
              }`
            : `Merge failed${res.status ? ` (HTTP ${res.status})` : ""}${
                res.fields && res.fields.length > 0 ? `; ChurchTools rejected: ${res.fields.join(", ")}` : ""
              }.${
                res.groupsDone && res.groupsDone.length > 0
                  ? ` Gruppen ${res.groupsDone.map((g) => g.groupId).join(", ")} wurden schon vorbereitet (Duplikat entfernt).`
                  : " Nothing was changed."
              }`,
      ]);
    } else {
      setOutcome("merged");
      setMessage([
        res.duplicateStillExists
          ? "Merged. ChurchTools kept the duplicate record (it was not deleted); the merge is recorded."
          : res.checkFailed
            ? "Merged, but could not check whether the duplicate record still exists."
            : res.afterError
              ? "The request reported an error, but the duplicate is gone; the merge is recorded."
              : "Merged.",
        ...res.warnings,
      ]);
    }
    setMode("result");
  }

  // --- render ---
  if (mode === "result") {
    return (
      <Box flexDirection="column">
        {message.map((l, i) => (
          <Text key={i} color={outcome === "back" ? "red" : "green"}>
            {l}
          </Text>
        ))}
        <Text dimColor>Press any key to return to the list.</Text>
      </Box>
    );
  }
  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">{error}</Text>
        <Text dimColor>Esc: back</Text>
      </Box>
    );
  }
  if (!pair || !model) return <Text>Loading pair…</Text>;

  const labels = deps.labels;
  const show = (key: string, v: unknown): string => {
    const text = formatValue(key, v, labels);
    return typeof v === "number" && labels[key]?.has(v) ? text : r.value(text);
  };
  const nameOf = (p: PairData["original"]): string => r.name(p.firstName, p.lastName);
  const date = (s: string): string => s.slice(0, 10);

  const labelW = 18;
  const colW = Math.max(10, Math.floor((cols - labelW - 8) / 3));
  const height = Math.max(5, rowsAvail - 16 - shared.length);
  const start = Math.min(Math.max(0, cursor - height + 1), Math.max(0, entries.length - height));
  const window = entries.slice(start, start + height);
  const gd = pair.preview.groupsDiff;

  const cell = (text: string, color?: "green" | "red", bold?: boolean): ReactElement => (
    <Text color={color} bold={bold}>
      {clip(text, colW)}
    </Text>
  );

  if (mode === "confirm") {
    const changed = model.fields.filter(
      (f) => f.choice !== "original" && (differs(f) || f.choice === "none"),
    );
    const included = model.emails.filter((e) => e.include);
    return (
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text bold>Zusammenführen?</Text>
        <Text>
          Duplikat {r.id(pair.duplicate.id)} wird in Original {r.id(pair.original.id)} zusammengeführt.
        </Text>
        <Text>
          ChurchTools verschiebt Gruppenmitgliedschaften und verknüpfte Daten und löscht das Duplikat.
        </Text>
        {shared.map((g) => (
          <Text key={g.id}>
            Gruppe {g.title}: {groupPlan(g)}
          </Text>
        ))}
        {changed.length === 0 ? (
          <Text dimColor>Alle Felder bleiben beim Original.</Text>
        ) : (
          changed.map((f) => (
            <Text key={f.key}>
              {f.label}: {show(f.key, f.original) || "(leer)"} →{" "}
              {f.choice === "none" ? "(leer)" : show(f.key, f.duplicate)}
            </Text>
          ))
        )}
        <Text>
          E-Mail-Adressen: {included.length} von {model.emails.length} übernommen
        </Text>
        <Text color="yellow">[y/Enter] ja [n/Esc] abbrechen</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <PersonCard
          title="Original"
          color="green"
          name={nameOf(pair.original)}
          id={`#${r.id(pair.original.id)}`}
          created={date(pair.original.createdDate)}
          login={date(pair.original.lastLogin)}
        />
        <PersonCard
          title="Duplikat"
          color="red"
          name={nameOf(pair.duplicate)}
          id={`#${r.id(pair.duplicate.id)}`}
          created={date(pair.duplicate.createdDate)}
          login={date(pair.duplicate.lastLogin)}
        />
      </Box>
      <Text bold>
        {clip("Feld", labelW)} {clip("Original", colW)} {clip("Ergebnis", colW)} {clip("Duplikat", colW)}
        {showIdentical ? "  (inkl. identische Felder)" : ""}
      </Text>
      {window.map((e) => {
        const selected = current !== undefined && entryId(e) === entryId(current);
        const pointer = selected ? "›" : " ";
        if (e.kind === "field") {
          const f = e.row;
          const diff = differs(f);
          const oText = show(f.key, f.original);
          const dText = show(f.key, f.duplicate);
          const result = f.choice === "original" ? oText : f.choice === "duplicate" ? dText : "";
          const oColor = diff ? (f.choice === "original" ? "green" : "red") : undefined;
          const dColor = diff ? (f.choice === "duplicate" ? "green" : "red") : undefined;
          return (
            <Box key={entryId(e)}>
              <Text inverse={selected}>
                {pointer}
                {clip(f.label, labelW - 1)}
              </Text>
              <Text> </Text>
              {cell(oText, oColor)}
              <Text> </Text>
              {cell(f.choice === "none" ? "(leer)" : result, "green", true)}
              <Text> </Text>
              {cell(dText, dColor)}
            </Box>
          );
        }
        if (e.kind === "group") {
          return (
            <Box key={entryId(e)}>
              <Text inverse={selected} bold color="yellow">
                {pointer}
                {clip(`Gruppe ${e.group.title}`, labelW + colW * 3 + 2)}
              </Text>
            </Box>
          );
        }
        if (e.kind === "member") {
          const i = e.row;
          const diff = itemDiffers(i);
          const oText = show(i.key, i.original);
          const dText = show(i.key, i.duplicate);
          const oColor = diff ? (i.choice === "original" ? "green" : "red") : undefined;
          const dColor = diff ? (i.choice === "duplicate" ? "green" : "red") : undefined;
          return (
            <Box key={entryId(e)}>
              <Text inverse={selected}>
                {pointer}
                {clip(`  ${i.label}`, labelW - 1)}
              </Text>
              <Text> </Text>
              {cell(oText, oColor)}
              <Text> </Text>
              {cell(i.choice === "original" ? oText : dText, "green", true)}
              <Text> </Text>
              {cell(dText, dColor)}
            </Box>
          );
        }
        const m = e.row;
        return (
          <Box key={entryId(e)}>
            <Text inverse={selected}>
              {pointer}
              {clip("E-Mail", labelW - 1)}
            </Text>
            <Text> </Text>
            {cell(m.originalEntry ? r.value(m.address) : "", m.include ? "green" : "red")}
            <Text> </Text>
            {cell(
              `[${m.include ? "x" : " "}] ${r.value(m.address)}${m.isDefault && m.include ? " *" : ""}`,
              "green",
              true,
            )}
            <Text> </Text>
            {cell(m.duplicateEntry ? r.value(m.address) : "", m.include ? "green" : "red")}
          </Box>
        );
      })}
      {entries.length === 0 ? (
        <Text dimColor>Keine abweichenden Felder. (i: identische Felder zeigen)</Text>
      ) : null}
      <Text dimColor>
        Gruppen: {gd.old.length} (Duplikat: {gd.new.length}), gemeinsam: {gd.both.length}. ChurchTools
        verschiebt die übrigen Mitgliedschaften beim Zusammenführen.
      </Text>
      {shared.map((g) => (
        <Text key={g.id} color="yellow">
          {clip(`Gruppe ${g.title}: ${groupPlan(g)}`, Math.max(20, cols - 1))}
        </Text>
      ))}
      <Text color="cyan">
        m Zusammenführen t Tauschen n Keine Dublette s Überspringen Esc Liste i Identische ←/→ Wert x
        leeren/umschalten * Standard-Adresse
      </Text>
      {mode === "busy" ? <Text color="yellow">Working…</Text> : null}
    </Box>
  );
}
