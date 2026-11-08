import type {
  BatchItem,
  BatchResponse,
  FileSummary,
  TagSuggestion,
} from "../shared/types";
import {
  appendBatchItems,
  batchItems,
  candidateRowsForBatch,
  countFiles,
  createBatch,
  fileRowById,
  getBatch,
  getSetting,
  setBatchItemStatus,
  summaryFromRow,
  tagsForFile,
  todayKey,
  untaggedCandidateRows,
} from "./db";
import { generateBatchAssets } from "./media";
import { faceListForFile, facesAvailable, queueFaceProcessing } from "./faces";
import { suggestionsForFile } from "./suggestions";

function goal(): number {
  const parsed = Number.parseInt(getSetting("dailyGoal") ?? "15", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(100, parsed)) : 15;
}

function chooseCandidates(
  date: string,
  amount: number,
): ReturnType<typeof untaggedCandidateRows> {
  const existing = new Set(batchItems(date).map((item) => item.file_id));
  const seed = untaggedCandidateRows(1, Array.from(existing))[0];
  if (!seed) return [];
  const chosen = [seed];
  const chosenIds = new Set([seed.id, ...existing]);
  const neighbors = candidateRowsForBatch(
    seed,
    amount - 1,
    Array.from(chosenIds),
  );
  for (const row of neighbors) {
    if (chosenIds.has(row.id)) continue;
    chosen.push(row);
    chosenIds.add(row.id);
    if (chosen.length >= amount) break;
  }
  if (chosen.length < amount) {
    for (const row of untaggedCandidateRows(amount - chosen.length, [
      ...chosenIds,
      ...existing,
    ])) {
      if (chosenIds.has(row.id)) continue;
      chosen.push(row);
      chosenIds.add(row.id);
      if (chosen.length >= amount) break;
    }
  }
  return chosen;
}

export function getOrCreateBatch(date = todayKey()): BatchResponse {
  const existing = getBatch(date);
  if (!existing) {
    const chosen = chooseCandidates(date, goal());
    if (chosen.length > 0)
      createBatch(
        date,
        goal(),
        chosen.map((row) => row.id),
      );
  }

  const batch = getBatch(date);
  if (!batch) {
    return {
      date,
      goal: goal(),
      done: 0,
      total: 0,
      caughtUp: true,
      facesPending: 0,
      items: [],
    };
  }

  const items = batchItems(date);
  const done = items.filter((item) => item.status === "done").length;
  const pending = items.filter((item) => item.status === "pending");
  const rows = pending
    .map((item) => fileRowById(item.file_id))
    .filter((row): row is NonNullable<typeof row> => row !== null);

  let facesPending = 0;
  if (facesAvailable()) {
    for (const row of rows) {
      if (row.faces_processed === 0) {
        facesPending++;
        queueFaceProcessing(row);
      }
    }
  }

  const batchItemsResponse: BatchItem[] = rows.map((row) => {
    const tags = tagsForFile(row.id);
    return {
      ...summaryFromRow(row, tags),
      description: row.description ?? "",
      faces: faceListForFile(row.id),
      suggestions: suggestionsForFile(row, date) as TagSuggestion[],
    };
  });

  void generateBatchAssets(rows);

  return {
    date,
    goal: batch.goal,
    done,
    total: items.length,
    caughtUp: pending.length === 0,
    facesPending,
    items: batchItemsResponse,
  };
}

export function extendBatch(date = todayKey()): BatchResponse {
  const batch = getBatch(date);
  if (!batch) return getOrCreateBatch(date);
  const chosen = chooseCandidates(date, goal());
  if (chosen.length > 0)
    appendBatchItems(
      date,
      chosen.map((row) => row.id),
    );
  return getOrCreateBatch(date);
}

export function markBatchItem(
  date: string,
  fileId: number,
  status: "done" | "skipped" | "pending",
): void {
  setBatchItemStatus(date, fileId, status);
}

export function todayProgress(date = todayKey()): {
  done: number;
  total: number;
} {
  const items = batchItems(date);
  return {
    done: items.filter((item) => item.status === "done").length,
    total: items.length,
  };
}

export function batchSummaryForFile(fileId: number): FileSummary | null {
  const row = fileRowById(fileId);
  return row ? summaryFromRow(row) : null;
}

export function untaggedCount(): number {
  return countFiles({ untagged: true });
}
