import type { TaskKind, TaskState } from "../shared/types";

let active: TaskState | null = null;

/** Start the single long-running task slot. Returns null when another task is active. */
export function beginTask(
  kind: TaskKind,
  total = 0,
  message: string | null = null,
): TaskState | null {
  if (active?.running) return null;
  active = {
    kind,
    running: true,
    processed: 0,
    total,
    errors: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    message,
  };
  return { ...active };
}

export function updateTask(
  patch: Partial<Pick<TaskState, "processed" | "total" | "errors" | "message">>,
): void {
  if (!active) return;
  Object.assign(active, patch);
}

export function finishTask(errors = 0, message: string | null = null): void {
  if (!active) return;
  active.running = false;
  active.errors = errors;
  active.message = message;
  active.finishedAt = new Date().toISOString();
}

export function getTask(): TaskState | null {
  return active ? { ...active } : null;
}

export function isTaskRunning(): boolean {
  return Boolean(active?.running);
}
