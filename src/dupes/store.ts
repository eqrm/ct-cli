/**
 * Local store for `ct dupes`: scan results, audit log, redaction key, exports.
 *
 * Lives in the user's data directory, never in a repository: directories 0700, files 0600.
 *   macOS  ~/Library/Application Support/ct-cli/dupes/<host-slug>/
 *   other  $XDG_DATA_HOME (default ~/.local/share)/ct-cli/dupes/<host-slug>/
 * `CT_DUPES_DIR` overrides the base directory (tests); it may not point into a git work tree.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Candidate } from "./detector.js";

export const SCAN_SCHEMA = "ct-cli.dupes.scan/1";

export type CandidateState = "open" | "dismissed" | "merged";

export interface StoredCandidate extends Candidate {
  state: CandidateState;
}

/**
 * States for a fresh scan: a pair decided earlier (dismissed or merged) keeps its decision, so a
 * dismissal whose write-back failed, or a merge recorded with both persons still present, does not
 * come back as open.
 */
export function carryStates(previous: ScanFile | null, candidates: readonly Candidate[]): StoredCandidate[] {
  const prior = new Map<string, CandidateState>();
  for (const c of previous?.candidates ?? []) if (c.state !== "open") prior.set(`${c.a}:${c.b}`, c.state);
  return candidates.map((c) => ({ ...c, state: prior.get(`${c.a}:${c.b}`) ?? "open" }));
}

export interface ScanFile {
  schema: typeof SCAN_SCHEMA;
  host: string;
  scannedAt: string;
  personsScanned: number;
  candidates: StoredCandidate[];
}

/** Lower-case host name with everything but `a-z0-9` collapsed to `-`. */
export function hostSlug(host: string): string {
  let name = host;
  try {
    name = new URL(host).host;
  } catch {
    /* keep raw */
  }
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function baseDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.CT_DUPES_DIR?.trim()) return resolve(env.CT_DUPES_DIR.trim());
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "ct-cli", "dupes");
  const data = env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(data, "ct-cli", "dupes");
}

/** Whether `dir` or any ancestor holds a `.git` entry. */
export function insideGitWorkTree(dir: string): boolean {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, ".git"))) return true;
    const up = dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

export class DupesStore {
  readonly dir: string;
  constructor(host: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform) {
    this.dir = join(baseDir(env, platform), hostSlug(host));
    if (insideGitWorkTree(this.dir)) {
      throw new Error("The dupes store must not be inside a repository.");
    }
  }

  get scanPath(): string {
    return join(this.dir, "candidates.json");
  }
  get auditPath(): string {
    return join(this.dir, "audit.jsonl");
  }
  get exportDir(): string {
    return join(this.dir, "exports");
  }
  private get keyPath(): string {
    return join(this.dir, "redact.key");
  }

  /** Create `dir` (and parents inside the store) with mode 0700. */
  ensureDir(dir: string = this.dir): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by umask; enforce it on the store dir and the target.
    chmodSync(this.dir, 0o700);
    chmodSync(dir, 0o700);
  }

  private writePrivate(path: string, content: string): void {
    this.ensureDir(dirname(path));
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
  }

  /** Local secret for stable pseudonyms; created on first use. */
  redactSecret(): string {
    if (existsSync(this.keyPath)) return readFileSync(this.keyPath, "utf8").trim();
    const secret = randomBytes(32).toString("hex");
    this.writePrivate(this.keyPath, `${secret}\n`);
    return secret;
  }

  saveScan(scan: ScanFile): void {
    this.writePrivate(this.scanPath, `${JSON.stringify(scan, null, 2)}\n`);
  }

  loadScan(): ScanFile | null {
    if (!existsSync(this.scanPath)) return null;
    const parsed = JSON.parse(readFileSync(this.scanPath, "utf8")) as ScanFile;
    if (parsed.schema !== SCAN_SCHEMA) throw new Error("Unsupported scan file version.");
    return parsed;
  }

  /** Append one audit line (`ts` is added). */
  audit(entry: Record<string, unknown>, now: Date = new Date()): void {
    this.ensureDir();
    const line = `${JSON.stringify({ ts: now.toISOString(), ...entry })}\n`;
    const fresh = !existsSync(this.auditPath);
    appendFileSync(this.auditPath, line, { mode: 0o600 });
    if (fresh) chmodSync(this.auditPath, 0o600);
  }

  readAudit(): Array<Record<string, unknown>> {
    if (!existsSync(this.auditPath)) return [];
    return readFileSync(this.auditPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  writeExport(name: string, content: string): string {
    const path = join(this.exportDir, name);
    this.writePrivate(path, content);
    return path;
  }
}
