import { useApp } from "ink";
import { useState, type ReactElement } from "react";
import type { ReviewDeps } from "../actions.js";
import type { ScanFile, StoredCandidate } from "../store.js";
import { ListScreen, type Names } from "./ListScreen.js";
import { PairScreen, type PairOutcome } from "./PairScreen.js";

export function App(props: { deps: ReviewDeps; scan: ScanFile; names: Names }): ReactElement {
  const { deps, scan, names } = props;
  const app = useApp();
  const [current, setCurrent] = useState<StoredCandidate | null>(null);
  const [focus, setFocus] = useState(() =>
    Math.max(
      0,
      scan.candidates.findIndex((c) => c.state === "open"),
    ),
  );
  const [, bump] = useState(0);

  const done = (cand: StoredCandidate, outcome: PairOutcome): void => {
    if (outcome === "merged") cand.state = "merged";
    if (outcome === "dismissed") cand.state = "dismissed";
    if (outcome === "merged" || outcome === "dismissed") deps.store.saveScan(scan);
    const idx = scan.candidates.indexOf(cand);
    const next = scan.candidates.findIndex((c, i) => i > idx && c.state === "open");
    setFocus(outcome === "back" ? idx : next >= 0 ? next : idx);
    setCurrent(null);
    bump((n) => n + 1);
  };

  if (current) {
    return (
      <PairScreen
        key={`${current.a}:${current.b}`}
        deps={deps}
        cand={current}
        onDone={(o) => done(current, o)}
      />
    );
  }
  return (
    <ListScreen
      candidates={scan.candidates}
      names={names}
      redactor={deps.redactor}
      focus={focus}
      onOpen={setCurrent}
      onQuit={() => app.exit()}
    />
  );
}
