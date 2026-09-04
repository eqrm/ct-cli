import { randomUUID } from "node:crypto";
import type { OperationEvent } from "../application/contracts.js";
import type { OperationObserver } from "../application/ports.js";

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface OperationRun {
  id: string;
  operation: string;
  status: RunStatus;
  events: OperationEvent[];
  result?: unknown;
  error?: unknown;
  createdAt: string;
  completedAt?: string;
}

export class OperationRunStore {
  private readonly runs = new Map<string, OperationRun>();
  private readonly controllers = new Map<string, AbortController>();

  create(operation: string): { run: OperationRun; observer: OperationObserver } {
    const run: OperationRun = {
      id: randomUUID(),
      operation,
      status: "running",
      events: [],
      createdAt: new Date().toISOString(),
    };
    this.runs.set(run.id, run);
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    return {
      run,
      observer: {
        emit: (event) => {
          if (controller.signal.aborted) throw new DOMException("Operation was cancelled.", "AbortError");
          run.events.push(event);
        },
      },
    };
  }

  get(id: string): OperationRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Unknown operation run "${id}".`);
    return run;
  }

  succeed(id: string, result: unknown): void {
    const run = this.get(id);
    if (run.status === "cancelled") return;
    run.status = "succeeded";
    run.result = result;
    run.completedAt = new Date().toISOString();
  }

  fail(id: string, error: unknown): void {
    const run = this.get(id);
    if (run.status === "cancelled") return;
    run.status = "failed";
    run.error = error;
    run.completedAt = new Date().toISOString();
  }

  cancel(id: string): OperationRun {
    const run = this.get(id);
    if (run.status !== "running") throw new Error(`Operation run is already ${run.status}.`);
    run.status = "cancelled";
    run.completedAt = new Date().toISOString();
    this.controllers.get(id)?.abort();
    return run;
  }
}
