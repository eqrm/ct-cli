/** Entry point, imported lazily by `ct dupes review` so other commands never load Ink or React. */
import { render } from "ink";
import { loadNames, type ReviewDeps } from "../actions.js";
import type { ScanFile } from "../store.js";
import { App } from "./App.js";

export async function runReviewTui(deps: ReviewDeps, scan: ScanFile): Promise<void> {
  const names = await loadNames(deps.client);
  const instance = render(<App deps={deps} scan={scan} names={names} />);
  await instance.waitUntilExit();
}
