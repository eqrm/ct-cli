/** Entry point of the browser review, imported lazily by `ct dupes review`. */
import { spawn } from "node:child_process";
import { loadNames, type ReviewDeps } from "../actions.js";
import type { ScanFile } from "../store.js";
import { info } from "../../ui.js";
import { startReviewServer } from "./server.js";

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* the address is printed anyway */
  }
}

export async function runReviewWeb(deps: ReviewDeps, scan: ScanFile, opts: { open: boolean }): Promise<void> {
  const names = await loadNames(deps.client);
  const server = await startReviewServer(deps, scan, names);
  info(`Review läuft im Browser: ${server.url}`);
  info("Beenden mit dem Button oben rechts oder Ctrl-C.");
  if (opts.open) openBrowser(server.url);
  const stop = (): void => server.close();
  process.once("SIGINT", stop);
  try {
    await server.closed;
  } finally {
    process.off("SIGINT", stop);
  }
}
