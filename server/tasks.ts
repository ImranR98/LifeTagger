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
    phase: null,
    processed: 0,
    total,
    errors: 0,
    cancelRequested: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    message,
  };
  return { ...active };
}

export function updateTask(
  patch: Partial<
    Pick<TaskState, "phase" | "processed" | "total" | "errors" | "message">
  >,
): void {
  if (!active) return;
  Object.assign(active, patch);
}

export function requestTaskCancel(): boolean {
  if (!active?.running) return false;
  active.cancelRequested = true;
  active.message = "Cancelling…";
  return true;
}

export function isTaskCancelRequested(): boolean {
  return Boolean(active?.running && active.cancelRequested);
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

/** A face scan does not write media metadata, so tagging can continue during it. */
export function isWriteTaskRunning(): boolean {
  return Boolean(active?.running && active.kind !== "face-scan");
}
