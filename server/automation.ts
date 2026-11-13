import fs from "node:fs";
import type { ReviewCounts, ReviewSuggestion } from "../shared/types";
import { hasLegacyTags, normalizeValue, valueNorm } from "../shared/tag-format";
import { config, serverLog } from "./config";
import {
  type FaceRow,
  type FileRow,
  addTagToFile,
  db,
  faceForId,
  fileRowById,
  getSetting,
  promoteFileTagSource,
  referenceFaces,
  setFaceLabel,
  tagsForFile,
  todayKey,
  updateFileAfterWrite,
} from "./db";
import { absolutePathFor } from "./media";
import { writeMetadata } from "./metadata";
import {
  embeddingToArray,
  facesAvailable,
  invalidateKnownFaces,
  processFacesForFile,
} from "./faces";
import { indexState } from "./indexer";
import {
  beginTask,
  finishTask,
  isTaskCancelRequested,
  isTaskRunning,
  updateTask,
} from "./tasks";
import { withFileLock } from "./file-lock";

export type AutomationSettings = {
  faceAutoThreshold: number;
  faceAutoMargin: number;
  faceReviewThreshold: number;
  faceMinQuality: number;
  placeAutoRadiusM: number;
  placeReviewRadiusM: number;
};

function settingNumber(key: string, fallback: number): number {
  const parsed = Number.parseFloat(getSetting(key) ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function automationSettings(): AutomationSettings {
  return {
    faceAutoThreshold: settingNumber(
      "faceAutoThreshold",
      config.faceAutoThreshold,
    ),
    faceAutoMargin: settingNumber("faceAutoMargin", config.faceAutoMargin),
    faceReviewThreshold: config.faceMatchThreshold,
    faceMinQuality: settingNumber("faceMinQuality", config.faceMinQuality),
    placeAutoRadiusM: Math.max(
      1,
      settingNumber("placeAutoRadiusM", config.placeAutoRadiusM),
    ),
    placeReviewRadiusM: Math.max(
      1,
      settingNumber("placeReviewRadiusM", config.placeReviewRadiusM),
    ),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function createRun(kind: string, options: Record<string, unknown>): number {
  const result = db
    .prepare(
      "INSERT INTO automation_runs(kind, status, options, started_at) VALUES(?, 'running', ?, ?)",
    )
    .run(kind, JSON.stringify(options), nowIso());
  return Number(result.lastInsertRowid);
}

function setRunTotal(runId: number, total: number): void {
  db.prepare("UPDATE automation_runs SET total = ? WHERE id = ?").run(
    total,
    runId,
  );
}

function finishRun(
  runId: number,
  status: string,
  counts: { processed: number; auto: number; review: number; errors: number },
): void {
  db.prepare(
    "UPDATE automation_runs SET status = ?, processed = ?, auto_added = ?, review_added = ?, errors = ?, finished_at = ? WHERE id = ?",
  ).run(
    status,
    counts.processed,
    counts.auto,
    counts.review,
    counts.errors,
    nowIso(),
    runId,
  );
}

type SuggestionStatus = "pending" | "approved" | "rejected";

function suggestionStatus(
  kind: "face" | "place",
  fileId: number,
  subjectId: number,
  key: string,
  value: string,
): SuggestionStatus | null {
  const row = db
    .prepare(
      `SELECT status FROM automation_suggestions
       WHERE kind = ? AND file_id = ? AND subject_id = ? AND key = ? AND value_norm = ?`,
    )
    .get(kind, fileId, subjectId, key, valueNorm(value)) as
    { status: SuggestionStatus } | undefined;
  return row?.status ?? null;
}

function insertSuggestion(input: {
  runId: number;
  kind: "face" | "place";
  fileId: number;
  faceId: number | null;
  key: string;
  value: string;
  confidence: number;
  distanceM: number | null;
  details?: Record<string, unknown>;
  status: SuggestionStatus;
}): boolean {
  const subjectId = input.faceId ?? 0;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO automation_suggestions(
        run_id, kind, file_id, face_id, subject_id, key, value, value_norm,
        confidence, distance_m, details, status, created_at, decided_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.runId,
      input.kind,
      input.fileId,
      input.faceId,
      subjectId,
      input.key,
      normalizeValue(input.value),
      valueNorm(input.value),
      input.confidence,
      input.distanceM,
      input.details ? JSON.stringify(input.details) : null,
      input.status,
      nowIso(),
      input.status === "pending" ? null : nowIso(),
    );
  if (Number(result.changes) === 0 && input.status === "pending") {
    db.prepare(
      `UPDATE automation_suggestions
       SET run_id = ?, confidence = ?, distance_m = ?, details = ?, created_at = ?
       WHERE kind = ? AND file_id = ? AND subject_id = ? AND key = ? AND value_norm = ?
         AND status = 'pending'`,
    ).run(
      input.runId,
      input.confidence,
      input.distanceM,
      input.details ? JSON.stringify(input.details) : null,
      nowIso(),
      input.kind,
      input.fileId,
      subjectId,
      input.key,
      valueNorm(input.value),
    );
  }
  return Number(result.changes) > 0;
}

function supersedeOtherPendingSuggestions(input: {
  kind: "face" | "place";
  fileId: number;
  subjectId: number;
  key: string;
  value: string;
}): void {
  db.prepare(
    `UPDATE automation_suggestions
     SET status = 'rejected', decided_at = ?
     WHERE status = 'pending' AND kind = ? AND file_id = ? AND subject_id = ?
       AND key = ? AND value_norm <> ?`,
  ).run(
    nowIso(),
    input.kind,
    input.fileId,
    input.subjectId,
    input.key,
    valueNorm(input.value),
  );
}

function markSuggestionApproved(input: {
  runId: number;
  kind: "face" | "place";
  fileId: number;
  faceId: number | null;
  key: string;
  value: string;
  confidence: number;
  distanceM: number | null;
  details?: Record<string, unknown>;
}): void {
  const subjectId = input.faceId ?? 0;
  const result = db
    .prepare(
      `UPDATE automation_suggestions
       SET status = 'approved', run_id = ?, confidence = ?, distance_m = ?,
           details = ?, decided_at = ?
       WHERE kind = ? AND file_id = ? AND subject_id = ? AND key = ? AND value_norm = ?
         AND status = 'pending'`,
    )
    .run(
      input.runId,
      input.confidence,
      input.distanceM,
      input.details ? JSON.stringify(input.details) : null,
      nowIso(),
      input.kind,
      input.fileId,
      subjectId,
      input.key,
      valueNorm(input.value),
    );
  if (Number(result.changes) === 0) {
    insertSuggestion({ ...input, status: "approved" });
  }
}

async function persistFileTags(fileId: number): Promise<boolean> {
  const row = fileRowById(fileId);
  if (!row) return false;
  const absolute = absolutePathFor(row);
  if (!absolute) return false;
  const tags = tagsForFile(fileId);
  try {
    const written = await writeMetadata({
      relativePath: row.path,
      absolutePath: absolute,
      tags,
      description: row.description ?? "",
    });
    const stat = await fs.promises.stat(absolute);
    updateFileAfterWrite(fileId, {
      description: row.description ?? "",
      tags,
      metadataWritable: written.metadataWritable,
      mtimeMs: Math.floor(stat.mtimeMs),
      size: stat.size,
      captureAt: written.captureAt ?? row.capture_at,
      localDate: written.localDate ?? row.local_date,
      legacyPending: hasLegacyTags(row.name, row.description ?? ""),
    });
    return written.metadataWritable;
  } catch (error) {
    serverLog.warn("automation metadata write failed", row.path, error);
    return false;
  }
}

async function persistFiles(
  fileIds: Iterable<number>,
  counts: { errors: number },
): Promise<void> {
  for (const fileId of fileIds) {
    if (!(await withFileLock(fileId, () => persistFileTags(fileId)))) {
      counts.errors++;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

let placePromise: Promise<void> | null = null;
let facePromise: Promise<void> | null = null;
let scanPromise: Promise<void> | null = null;
let reviewPromise: Promise<void> | null = null;

export function startPlaceAutomation(): {
  started: boolean;
  reason?: string;
} {
  if (indexState.running)
    return { started: false, reason: "Wait for the library index to finish" };
  if (isTaskRunning() || placePromise)
    return { started: false, reason: "Another task is already running" };
  const references = db
    .prepare(
      `SELECT COUNT(*) AS count FROM files f
       JOIN file_tags ft ON ft.file_id = f.id
       JOIN tags t ON t.id = ft.tag_id
       WHERE t.key = 'place' AND f.gps_lat IS NOT NULL AND f.gps_lon IS NOT NULL
         AND ft.source NOT IN ('place-auto')`,
    )
    .get() as { count: number };
  if (references.count === 0)
    return {
      started: false,
      reason: "No trusted place tags with GPS coordinates yet",
    };
  const task = beginTask("place-auto", 0, "Propagating place tags");
  if (!task)
    return { started: false, reason: "Another task is already running" };
  placePromise = runPlaceAutomation()
    .catch((error) => serverLog.error("place automation failed", error))
    .finally(() => {
      placePromise = null;
    });
  return { started: true };
}

async function runPlaceAutomation(): Promise<void> {
  const counts = { processed: 0, auto: 0, review: 0, errors: 0 };
  let runId: number | null = null;
  try {
    const settings = automationSettings();
    runId = createRun("place-auto", settings);
    const references = db
      .prepare(
        `SELECT f.gps_lat AS lat, f.gps_lon AS lon, t.value AS place
         FROM files f
         JOIN file_tags ft ON ft.file_id = f.id
         JOIN tags t ON t.id = ft.tag_id
         WHERE t.key = 'place'
           AND f.gps_lat IS NOT NULL AND f.gps_lon IS NOT NULL
           AND ft.source NOT IN ('place-auto')`,
      )
      .all() as { lat: number; lon: number; place: string }[];

    if (references.length === 0) {
      finishTask(0, "No trusted place tags with GPS coordinates found");
      finishRun(runId, "complete", counts);
      return;
    }

    const targets = db
      .prepare(
        `SELECT f.* FROM files f
         WHERE f.gps_lat IS NOT NULL AND f.gps_lon IS NOT NULL
           AND f.legacy_pending = 0
           AND NOT EXISTS (
             SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
             WHERE ft.file_id = f.id AND t.key = 'place'
           )
           AND NOT EXISTS (
             SELECT 1 FROM daily_items di
             WHERE di.file_id = f.id AND di.date = ? AND di.status = 'pending'
           )`,
      )
      .all(todayKey()) as FileRow[];

    setRunTotal(runId, targets.length);
    updateTask({ total: targets.length, processed: 0 });

    const cellSize = Math.max(0.01, settings.placeReviewRadiusM / 111_320 / 10);
    const grid = new Map<
      string,
      { lat: number; lon: number; place: string }[]
    >();
    const cellKey = (lat: number, lon: number) =>
      `${Math.floor(lat / cellSize)}:${Math.floor(lon / cellSize)}`;
    for (const reference of references) {
      const key = cellKey(reference.lat, reference.lon);
      const list = grid.get(key) ?? [];
      list.push(reference);
      grid.set(key, list);
    }

    for (const file of targets) {
      if (isTaskCancelRequested()) {
        finishTask(counts.errors, "Place automation cancelled");
        finishRun(runId, "cancelled", counts);
        return;
      }
      counts.processed++;
      try {
        const lat = file.gps_lat!;
        const lon = file.gps_lon!;
        const cellLat = Math.floor(lat / cellSize);
        const cellLon = Math.floor(lon / cellSize);
        const latSteps = Math.ceil(
          settings.placeReviewRadiusM / (111_320 * cellSize),
        );
        const lonSteps = Math.ceil(
          settings.placeReviewRadiusM /
            (111_320 *
              Math.max(0.01, Math.cos((lat * Math.PI) / 180)) *
              cellSize),
        );
        const bestByPlace = new Map<string, number>();
        for (let dLat = -latSteps; dLat <= latSteps; dLat++) {
          for (let dLon = -lonSteps; dLon <= lonSteps; dLon++) {
            const cell = grid.get(`${cellLat + dLat}:${cellLon + dLon}`) ?? [];
            for (const reference of cell) {
              const distance = haversineMeters(
                lat,
                lon,
                reference.lat,
                reference.lon,
              );
              if (distance > settings.placeReviewRadiusM) continue;
              const current = bestByPlace.get(reference.place);
              if (current === undefined || distance < current)
                bestByPlace.set(reference.place, distance);
            }
          }
        }
        const sorted = Array.from(bestByPlace.entries())
          .map(([place, distance]) => ({ place, distance }))
          .sort((a, b) => a.distance - b.distance);
        const best = sorted[0];
        if (!best) continue;
        const second = sorted.find((entry) => entry.place !== best.place);
        const confidence = Math.max(
          0,
          1 - best.distance / settings.placeReviewRadiusM,
        );
        const ambiguous =
          Boolean(second) &&
          second!.distance <= Math.max(settings.placeAutoRadiusM * 2, 100);
        await withFileLock(file.id, async () => {
          const existing = suggestionStatus(
            "place",
            file.id,
            0,
            "place",
            best.place,
          );
          if (existing === "approved" || existing === "rejected") return;
          supersedeOtherPendingSuggestions({
            kind: "place",
            fileId: file.id,
            subjectId: 0,
            key: "place",
            value: best.place,
          });
          if (best.distance <= settings.placeAutoRadiusM && !ambiguous) {
            addTagToFile(
              file.id,
              { key: "place", value: best.place },
              "place-auto",
            );
            markSuggestionApproved({
              runId: runId!,
              kind: "place",
              fileId: file.id,
              faceId: null,
              key: "place",
              value: best.place,
              confidence,
              distanceM: best.distance,
              details: { second: second ?? null },
            });
            const written = await persistFileTags(file.id);
            if (!written) counts.errors++;
            counts.auto++;
          } else {
            const inserted = insertSuggestion({
              runId: runId!,
              kind: "place",
              fileId: file.id,
              faceId: null,
              key: "place",
              value: best.place,
              confidence,
              distanceM: best.distance,
              details: { second: second ?? null, ambiguous },
              status: "pending",
            });
            if (inserted || existing === "pending") counts.review++;
          }
        });
      } catch (error) {
        counts.errors++;
        serverLog.warn("place automation failed", file.path, error);
      }
      if (counts.processed % 50 === 0)
        updateTask({ processed: counts.processed, errors: counts.errors });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    finishTask(
      counts.errors,
      `Places: ${counts.auto} auto-tagged, ${counts.review} review suggestions`,
    );
    finishRun(runId, "complete", counts);
  } catch (error) {
    counts.errors++;
    finishTask(1, "Place automation failed");
    if (runId !== null) finishRun(runId, "failed", counts);
    throw error;
  } finally {
    updateTask({ processed: counts.processed, errors: counts.errors });
    if (isTaskRunning()) {
      finishTask(counts.errors, "Place automation stopped");
    }
  }
}

export function startFaceAutomation(): {
  started: boolean;
  reason?: string;
} {
  if (indexState.running)
    return { started: false, reason: "Wait for the library index to finish" };
  if (isTaskRunning() || facePromise)
    return { started: false, reason: "Another task is already running" };
  if (referenceFaces().length === 0)
    return {
      started: false,
      reason: "No trusted face labels yet. Label a face first.",
    };
  const task = beginTask("face-auto", 0, "Matching known faces");
  if (!task)
    return { started: false, reason: "Another task is already running" };
  facePromise = runFaceAutomation()
    .catch((error) => serverLog.error("face automation failed", error))
    .finally(() => {
      facePromise = null;
    });
  return { started: true };
}

async function runFaceAutomation(): Promise<void> {
  const counts = { processed: 0, auto: 0, review: 0, errors: 0 };
  let runId: number | null = null;
  const filesToPersist = new Set<number>();
  const flush = async () => {
    if (filesToPersist.size === 0) return;
    updateTask({ phase: "Writing metadata" });
    await persistFiles(filesToPersist, counts);
    filesToPersist.clear();
  };
  try {
    const settings = automationSettings();
    runId = createRun("face-auto", settings);
    const references = referenceFaces();
    if (references.length === 0) {
      finishTask(0, "No trusted face labels available");
      finishRun(runId, "complete", counts);
      return;
    }
    const byPerson = new Map<string, number[][]>();
    for (const reference of references) {
      if (!reference.label) continue;
      const list = byPerson.get(reference.label) ?? [];
      if (list.length < 20) list.push(embeddingToArray(reference.embedding));
      byPerson.set(reference.label, list);
    }
    const people = Array.from(byPerson.entries());
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM faces
           WHERE person_tag_id IS NULL AND quality >= ?
             AND EXISTS (SELECT 1 FROM files f WHERE f.id = faces.file_id AND f.legacy_pending = 0)`,
        )
        .get(settings.faceMinQuality) as { count: number }
    ).count;
    setRunTotal(runId, total);
    updateTask({ total, processed: 0, phase: "Matching faces" });
    let lastId = 0;

    while (true) {
      if (isTaskCancelRequested()) {
        await flush();
        finishTask(counts.errors, "Face matching cancelled");
        finishRun(runId, "cancelled", counts);
        return;
      }
      const rows = db
        .prepare(
          `SELECT faces.* FROM faces
           WHERE person_tag_id IS NULL AND quality >= ? AND id > ?
             AND EXISTS (SELECT 1 FROM files f WHERE f.id = faces.file_id AND f.legacy_pending = 0)
           ORDER BY id LIMIT 250`,
        )
        .all(settings.faceMinQuality, lastId) as FaceRow[];
      if (rows.length === 0) break;
      for (const face of rows) {
        lastId = face.id;
        counts.processed++;
        try {
          const own = embeddingToArray(face.embedding);
          let best = 0;
          let bestPerson: string | null = null;
          let second = 0;
          for (const [person, referenceEmbeddings] of people) {
            let personBest = 0;
            for (const reference of referenceEmbeddings) {
              const similarity = cosineLocal(own, reference);
              if (similarity > personBest) personBest = similarity;
            }
            if (personBest > best) {
              second = best;
              best = personBest;
              bestPerson = person;
            } else if (personBest > second) {
              second = personBest;
            }
          }
          if (!bestPerson || best < settings.faceReviewThreshold) continue;
          await withFileLock(face.file_id, async () => {
            const existing = suggestionStatus(
              "face",
              face.file_id,
              face.id,
              "people",
              bestPerson,
            );
            if (existing === "approved" || existing === "rejected") return;
            supersedeOtherPendingSuggestions({
              kind: "face",
              fileId: face.file_id,
              subjectId: face.id,
              key: "people",
              value: bestPerson,
            });
            if (
              best >= settings.faceAutoThreshold &&
              best - second >= settings.faceAutoMargin
            ) {
              setFaceLabel(face.id, bestPerson, {
                source: "face-auto",
                confidence: best,
                runId: runId!,
              });
              addTagToFile(
                face.file_id,
                { key: "people", value: bestPerson },
                "face-auto",
              );
              markSuggestionApproved({
                runId: runId!,
                kind: "face",
                fileId: face.file_id,
                faceId: face.id,
                key: "people",
                value: bestPerson,
                confidence: best,
                distanceM: null,
                details: { margin: best - second },
              });
              filesToPersist.add(face.file_id);
              counts.auto++;
            } else {
              const inserted = insertSuggestion({
                runId: runId!,
                kind: "face",
                fileId: face.file_id,
                faceId: face.id,
                key: "people",
                value: bestPerson,
                confidence: best,
                distanceM: null,
                details: { margin: best - second },
                status: "pending",
              });
              if (inserted || existing === "pending") counts.review++;
            }
          });
        } catch (error) {
          counts.errors++;
          serverLog.warn("face automation failed", face.id, error);
        }
        if (counts.processed % 100 === 0)
          updateTask({ processed: counts.processed, errors: counts.errors });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await flush();
    invalidateKnownFaces();
    finishTask(
      counts.errors,
      `Faces: ${counts.auto} auto-tagged, ${counts.review} review suggestions`,
    );
    finishRun(runId, "complete", counts);
  } catch (error) {
    counts.errors++;
    try {
      await flush();
    } catch {
      // Keep the original failure as the reported task error.
    }
    finishTask(1, "Face matching failed");
    if (runId !== null) finishRun(runId, "failed", counts);
    throw error;
  } finally {
    updateTask({ processed: counts.processed, errors: counts.errors });
    if (isTaskRunning()) finishTask(counts.errors, "Face matching stopped");
  }
}

function cosineLocal(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function startFaceScan(options: { autoMatch?: boolean } = {}): {
  started: boolean;
  reason?: string;
} {
  if (!facesAvailable())
    return { started: false, reason: "Face detection is not available" };
  if (indexState.running)
    return { started: false, reason: "Wait for the library index to finish" };
  if (isTaskRunning() || scanPromise)
    return { started: false, reason: "Another task is already running" };
  const total = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM files WHERE faces_processed = 0 OR (faces_processed = 2 AND faces_attempts < 3)",
      )
      .get() as {
      count: number;
    }
  ).count;
  if (total === 0)
    return {
      started: false,
      reason: "There are no files waiting for face detection",
    };
  const task = beginTask("face-scan", total, "Scanning all faces");
  if (!task)
    return { started: false, reason: "Another task is already running" };
  scanPromise = runFaceScan(options)
    .catch((error) => serverLog.error("face scan failed", error))
    .finally(() => {
      scanPromise = null;
    });
  return { started: true };
}

async function runFaceScan(options: { autoMatch?: boolean }): Promise<void> {
  const counts = { processed: 0, auto: 0, review: 0, errors: 0 };
  let runId: number | null = null;
  let taskFinished = false;
  try {
    runId = createRun("face-scan", options);
    const total = (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM files WHERE faces_processed = 0 OR (faces_processed = 2 AND faces_attempts < 3)",
        )
        .get() as { count: number }
    ).count;
    setRunTotal(runId, total);
    let lastId = 0;
    while (true) {
      if (isTaskCancelRequested()) {
        finishTask(counts.errors, "Face scan cancelled");
        taskFinished = true;
        finishRun(runId, "cancelled", counts);
        return;
      }
      const rows = db
        .prepare(
          "SELECT * FROM files WHERE (faces_processed = 0 OR (faces_processed = 2 AND faces_attempts < 3)) AND id > ? ORDER BY id LIMIT 20",
        )
        .all(lastId) as FileRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        lastId = row.id;
        await processFacesForFile(row, { force: true });
        counts.processed++;
        const fresh = fileRowById(row.id);
        if (fresh?.faces_processed === 2) counts.errors++;
        updateTask({ processed: counts.processed, errors: counts.errors });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    finishTask(counts.errors, "Face scan complete");
    taskFinished = true;
    finishRun(runId, "complete", counts);
    if (options.autoMatch) startFaceAutomation();
  } catch (error) {
    counts.errors++;
    finishTask(1, "Face scan failed");
    taskFinished = true;
    if (runId !== null) finishRun(runId, "failed", counts);
    throw error;
  } finally {
    if (!taskFinished && isTaskRunning()) {
      finishTask(counts.errors, "Face scan stopped");
    }
  }
}

export function reviewCounts(): ReviewCounts {
  const rows = db
    .prepare(
      "SELECT kind, COUNT(*) AS count FROM automation_suggestions WHERE status = 'pending' GROUP BY kind",
    )
    .all() as { kind: "face" | "place"; count: number }[];
  const counts: ReviewCounts = { face: 0, place: 0, total: 0 };
  for (const row of rows) {
    counts[row.kind] = row.count;
    counts.total += row.count;
  }
  return counts;
}

export function listReviewSuggestions(options: {
  kind?: "face" | "place";
  cursor?: number;
  limit?: number;
}): {
  suggestions: ReviewSuggestion[];
  cursor: number | null;
  hasMore: boolean;
} {
  const limit = Math.max(1, Math.min(100, options.limit ?? 60));
  const conditions = ["s.status = 'pending'"];
  const params: (string | number)[] = [];
  if (options.kind) {
    conditions.push("s.kind = ?");
    params.push(options.kind);
  }
  if (options.cursor) {
    conditions.push("s.id > ?");
    params.push(options.cursor);
  }
  const rows = db
    .prepare(
      `SELECT s.*, f.mtime_ms
       FROM automation_suggestions s
       JOIN files f ON f.id = s.file_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY s.id ASC LIMIT ?`,
    )
    .all(...params, limit + 1) as {
    id: number;
    kind: "face" | "place";
    file_id: number;
    face_id: number | null;
    key: string;
    value: string;
    confidence: number;
    distance_m: number | null;
    mtime_ms: number;
  }[];
  const page = rows.slice(0, limit);
  return {
    suggestions: page.map((row) => ({
      id: row.id,
      kind: row.kind,
      fileId: row.file_id,
      faceId: row.face_id,
      key: row.key,
      value: row.value,
      confidence: row.confidence,
      distanceM: row.distance_m,
      thumbUrl:
        row.kind === "face" && row.face_id
          ? `/api/faces/${row.face_id}/thumb?v=${row.face_id}`
          : `/api/files/${row.file_id}/thumb?v=${row.mtime_ms}`,
    })),
    cursor: page.at(-1)?.id ?? null,
    hasMore: rows.length > limit,
  };
}

export function rejectReviewSuggestions(ids: number[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE automation_suggestions SET status = 'rejected', decided_at = ?
       WHERE id IN (${placeholders}) AND status = 'pending'`,
    )
    .run(nowIso(), ...ids);
  return Number(result.changes);
}

export function resetRejectedSuggestions(): number {
  const deleted = Number(
    db
      .prepare("DELETE FROM automation_suggestions WHERE status = 'rejected'")
      .run().changes,
  );
  db.prepare("DELETE FROM suggestion_feedback").run();
  return deleted;
}

export function startReviewApproval(ids: number[]): {
  started: boolean;
  reason?: string;
  updated?: number;
} {
  if (ids.length === 0)
    return { started: false, reason: "No suggestions selected" };
  if (indexState.running)
    return { started: false, reason: "Wait for the library index to finish" };
  if (isTaskRunning() || reviewPromise)
    return { started: false, reason: "Another task is already running" };
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM automation_suggestions
       WHERE id IN (${placeholders}) AND status = 'pending'`,
    )
    .all(...ids) as {
    id: number;
    kind: "face" | "place";
    file_id: number;
    face_id: number | null;
    value: string;
    confidence: number;
  }[];
  if (rows.length === 0)
    return {
      started: false,
      reason: "Those suggestions are no longer pending",
    };
  const task = beginTask(
    "review-apply",
    rows.length,
    "Applying review suggestions",
  );
  if (!task)
    return { started: false, reason: "Another task is already running" };
  reviewPromise = runReviewApproval(rows)
    .catch((error) => serverLog.error("review approval failed", error))
    .finally(() => {
      reviewPromise = null;
    });
  return { started: true };
}

async function runReviewApproval(
  rows: {
    id: number;
    kind: "face" | "place";
    file_id: number;
    face_id: number | null;
    value: string;
    confidence: number;
  }[],
): Promise<void> {
  const counts = { processed: 0, auto: 0, review: 0, errors: 0 };
  let runId: number | null = null;
  const filesToPersist = new Set<number>();
  const flush = async () => {
    if (filesToPersist.size === 0) return;
    await persistFiles(filesToPersist, counts);
    filesToPersist.clear();
  };
  try {
    runId = createRun("review-apply", { count: rows.length });
    for (const row of rows) {
      if (isTaskCancelRequested()) {
        await flush();
        finishTask(counts.errors, "Review apply cancelled");
        finishRun(runId, "cancelled", counts);
        return;
      }
      counts.processed++;
      try {
        const suggestion = row;
        await withFileLock(suggestion.file_id, async () => {
          if (suggestion.kind === "face") {
            if (!suggestion.face_id) throw new Error("missing face");
            const face = faceForId(suggestion.face_id);
            if (!face) throw new Error("face no longer exists");
            if (face.person_tag_id !== null && face.label !== suggestion.value)
              throw new Error("face already has a different label");
            setFaceLabel(suggestion.face_id, suggestion.value, {
              source: "review",
              confidence: suggestion.confidence,
              runId: runId!,
            });
            addTagToFile(
              suggestion.file_id,
              { key: "people", value: suggestion.value },
              "review",
            );
            promoteFileTagSource(
              suggestion.file_id,
              "people",
              suggestion.value,
              "review",
            );
          } else {
            const existingPlace = tagsForFile(suggestion.file_id).find(
              (tag) =>
                tag.key === "place" &&
                valueNorm(tag.value) !== valueNorm(suggestion.value),
            );
            if (existingPlace)
              throw new Error("file already has a different place tag");
            addTagToFile(
              suggestion.file_id,
              { key: "place", value: suggestion.value },
              "review",
            );
            promoteFileTagSource(
              suggestion.file_id,
              "place",
              suggestion.value,
              "review",
            );
          }
          db.prepare(
            "UPDATE automation_suggestions SET status = 'approved', decided_at = ? WHERE id = ?",
          ).run(nowIso(), suggestion.id);
          filesToPersist.add(suggestion.file_id);
        });
      } catch (error) {
        counts.errors++;
        serverLog.warn("review suggestion failed", row.id, error);
      }
      updateTask({ processed: counts.processed, errors: counts.errors });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await flush();
    invalidateKnownFaces();
    finishTask(
      counts.errors,
      `Review: ${rows.length - counts.errors} applied, ${counts.errors} errors`,
    );
    finishRun(runId, "complete", counts);
  } catch (error) {
    counts.errors++;
    try {
      await flush();
    } catch {
      // Keep the original failure as the reported task error.
    }
    finishTask(1, "Review apply failed");
    if (runId !== null) finishRun(runId, "failed", counts);
    throw error;
  } finally {
    if (isTaskRunning()) finishTask(counts.errors, "Review apply stopped");
  }
}

export function confirmAutoTag(
  fileId: number,
  key: string,
  value: string,
): boolean {
  const promoted = promoteFileTagSource(fileId, key, value, "review");
  if (promoted) invalidateKnownFaces();
  return promoted;
}

export function automationRunCounts(): {
  id: number;
  kind: string;
  status: string;
  processed: number;
  total: number;
  autoAdded: number;
  reviewAdded: number;
  errors: number;
  startedAt: string;
  finishedAt: string | null;
}[] {
  return db
    .prepare(
      `SELECT id, kind, status, processed, total, auto_added AS autoAdded,
                review_added AS reviewAdded, errors, started_at AS startedAt,
                finished_at AS finishedAt
         FROM automation_runs ORDER BY id DESC LIMIT 50`,
    )
    .all() as {
    id: number;
    kind: string;
    status: string;
    processed: number;
    total: number;
    autoAdded: number;
    reviewAdded: number;
    errors: number;
    startedAt: string;
    finishedAt: string | null;
  }[];
}
