import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export interface Workspace {
  id: string;
  name: string;
  path: string;
}

function workspaceId(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

export class WorkspaceRegistry {
  readonly workspaces: readonly Workspace[];

  private constructor(workspaces: Workspace[]) {
    this.workspaces = workspaces;
  }

  static async create(paths: readonly string[]): Promise<WorkspaceRegistry> {
    if (paths.length === 0) throw new Error("Configure at least one workspace root.");
    const unique = new Set<string>();
    for (const path of paths) {
      const normalized = await realpath(resolve(path));
      if (!(await stat(normalized)).isDirectory())
        throw new Error(`Workspace root is not a directory: ${path}`);
      unique.add(normalized);
    }
    return new WorkspaceRegistry(
      [...unique].map((path) => ({ id: workspaceId(path), name: basename(path) || path, path })),
    );
  }

  get(id: string): Workspace {
    const workspace = this.workspaces.find((candidate) => candidate.id === id);
    if (!workspace) throw new Error(`Unknown workspace "${id}".`);
    return workspace;
  }

  resolveWithin(workspace: Workspace, input: string = "."): string {
    const candidate = resolve(workspace.path, input);
    if (!contained(workspace.path, candidate)) {
      throw new Error(`Path escapes configured workspace ${workspace.name}.`);
    }
    return candidate;
  }

  async resolveSafeWithin(workspace: Workspace, input: string = "."): Promise<string> {
    const candidate = this.resolveWithin(workspace, input);
    let cursor = candidate;
    while (true) {
      try {
        const physical = await realpath(cursor);
        if (!contained(workspace.path, physical)) {
          throw new Error(`Path escapes configured workspace ${workspace.name} through a symlink.`);
        }
        return candidate;
      } catch (caught) {
        if (!(
          typeof caught === "object" &&
          caught !== null &&
          (caught as NodeJS.ErrnoException).code === "ENOENT"
        )) {
          throw caught;
        }
        const parent = resolve(cursor, "..");
        if (parent === cursor) throw new Error("Could not establish workspace path containment.");
        cursor = parent;
      }
    }
  }

  resolveAny(input: string): string {
    const candidate = resolve(input);
    if (!this.workspaces.some((workspace) => contained(workspace.path, candidate))) {
      throw new Error("Target is outside every configured workspace root.");
    }
    return candidate;
  }

  async resolveAnySafe(input: string): Promise<string> {
    const candidate = this.resolveAny(input);
    const workspace = this.workspaces.find((entry) => contained(entry.path, candidate));
    if (!workspace) throw new Error("Target is outside every configured workspace root.");
    return this.resolveSafeWithin(workspace, candidate);
  }
}
