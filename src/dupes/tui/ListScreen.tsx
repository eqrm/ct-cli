/** List screen: all candidates of the last scan. */
import { Box, Text, useInput, useStdout } from "ink";
import { useState, type ReactElement } from "react";
import type { Redactor } from "../redact.js";
import type { StoredCandidate } from "../store.js";

export type Names = Map<number, { first: string; last: string }>;

export function filterCandidates(all: readonly StoredCandidate[], tier: string | null): StoredCandidate[] {
  return tier === null ? [...all] : all.filter((c) => c.tier === tier);
}

export function ListScreen(props: {
  candidates: readonly StoredCandidate[];
  names: Names;
  redactor: Redactor;
  /** Index into the unfiltered list to put the cursor on. */
  focus: number;
  onOpen: (c: StoredCandidate) => void;
  onQuit: () => void;
}): ReactElement {
  const { candidates, names, redactor: r } = props;
  const { stdout } = useStdout();
  const height = Math.max(5, (stdout.rows ?? 30) - 8);
  const [tier, setTier] = useState<string | null>(null);
  const [cursor, setCursor] = useState(() => Math.max(0, props.focus));

  const list = filterCandidates(candidates, tier);
  const at = Math.min(cursor, Math.max(0, list.length - 1));
  const open = candidates.filter((c) => c.state === "open").length;

  useInput((input, key) => {
    if (input === "q") return props.onQuit();
    if (key.upArrow) setCursor(Math.max(0, at - 1));
    else if (key.downArrow) setCursor(Math.min(list.length - 1, at + 1));
    else if (key.pageUp) setCursor(Math.max(0, at - height));
    else if (key.pageDown) setCursor(Math.min(list.length - 1, at + height));
    else if (input === "1" || input === "2" || input === "3") {
      setTier(`T${input}`);
      setCursor(0);
    } else if (input === "a") {
      setTier(null);
      setCursor(0);
    } else if (key.return) {
      const c = list[at];
      if (c && c.state === "open") props.onOpen(c);
    }
  });

  const start = Math.min(Math.max(0, at - height + 1), Math.max(0, list.length - height));
  const name = (id: number): string => {
    const n = names.get(id);
    return n ? r.name(n.first, n.last) : `#${r.id(id)}`;
  };
  return (
    <Box flexDirection="column">
      <Text bold>
        Duplikate prüfen: {open} offen von {candidates.length} Filter: {tier ?? "alle"}
      </Text>
      <Text dimColor>Tier Score Klasse Quelle Original / Duplikat</Text>
      {list.slice(start, start + height).map((c, i) => {
        const selected = start + i === at;
        return (
          <Text key={`${c.a}:${c.b}`} inverse={selected} dimColor={c.state !== "open"}>
            {selected ? "›" : " "} {c.tier} {String(c.score).padEnd(5)} {c.matchClass.padEnd(11)}{" "}
            {c.source.padEnd(8)} {name(c.a)} / {name(c.b)} [{c.state}]
          </Text>
        );
      })}
      {list.length === 0 ? <Text dimColor>Keine Paare in diesem Filter.</Text> : null}
      <Text color="cyan">↑/↓ PgUp/PgDn bewegen Enter öffnen 1/2/3 Tier a alle q beenden</Text>
    </Box>
  );
}
