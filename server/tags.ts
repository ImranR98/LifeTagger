import fs from "node:fs";
import type { FileDetail, Tag } from "../shared/types";
import {
  TAG_KEY_RE,
  dedupeTags,
  hasLegacyTags,
  isValidTag,
  normalizeKey,
  normalizeValue,
  tagsEqual,
  valueNorm,
} from "../shared/tag-format";
import {
  db,
  fileRowById,
  replaceFileTags,
  summaryFromRow,
  tagsForFile,
  updateFileAfterWrite,
  updateFts,
  promoteAutoTagsForFile,
  recordUndo,
  undoEntry,
  markUndone,
  tagKeyList,
  allTagValues,
  setTagKey,
  setFaceLabel,
  bumpTagsRevision,
} from "./db";
import { serverLog } from "./config";
import { absolutePathFor } from "./media";
import { writeMetadata } from "./metadata";
import {
  faceListForFile,
  invalidateKnownFaces,
  queueFaceProcessing,
  reconcileFaceLabelsForFile,
  syncFaceLabelForFile,
} from "./faces";
import { withFileLock } from "./file-lock";
import { indexState } from "./indexer";
import {
  beginTask,
  finishTask,
  isTaskRunning,
  isWriteTaskRunning,
  updateTask,
} from "./tasks";

export function detailForFile(fileId: number): FileDetail | null {
  const row = fileRowById(fileId);
  if (!row) return null;
  return {
    ...summaryFromRow(row),
    description: row.description ?? "",
    metadataWritable: row.metadata_writable === 1,
    camera: row.camera,
    width: row.width,
    height: row.height,
    duration: row.duration_s,
    indexedAt: row.indexed_at,
    faces: faceListForFile(fileId),
  };
}

export type SaveResult = {
  detail: FileDetail;
  undoId: number | null;
  metadataWritable: boolean;
};

export async function saveFileTags(
  fileId: number,
  tags: Tag[],
  description: string,
  expectedRevision?: number,
): Promise<SaveResult> {
  if (isWriteTaskRunning())
    throw new Error("Wait for the current task to finish before saving");
  const nextTags = dedupeTags(tags);
  for (const tag of nextTags) {
    if (!isValidTag(tag))
      throw new Error(`Invalid tag: ${tag.key}=${tag.value}`);
  }
  return withFileLock(fileId, async () => {
    const row = fileRowById(fileId);
    if (!row) throw new Error("file not found");
    if (
      expectedRevision !== undefined &&
      row.tags_revision !== expectedRevision
    ) {
      throw new Error("This file changed elsewhere. Reload it and try again.");
    }
    const absolute = absolutePathFor(row);
    if (!absolute) throw new Error("file is outside the media root");
    const previousTags = tagsForFile(fileId);
    const previousDescription = row.description ?? "";
    const previousFaces = JSON.stringify(
      faceListForFile(fileId).map((face) => ({
        id: face.id,
        label: face.label,
      })),
    );
    const written = await writeMetadata({
      relativePath: row.path,
      absolutePath: absolute,
      tags: nextTags,
      description,
    });
    const stat = await fs.promises.stat(absolute);
    updateFileAfterWrite(fileId, {
      description,
      tags: nextTags,
      metadataWritable: written.metadataWritable,
      mtimeMs: Math.floor(stat.mtimeMs),
      size: stat.size,
      captureAt: written.captureAt ?? row.capture_at,
      localDate: written.localDate ?? row.local_date,
      legacyPending: hasLegacyTags(row.name, description),
    });
    reconcileFaceLabelsForFile(fileId);
    if (promoteAutoTagsForFile(fileId) > 0) invalidateKnownFaces();
    syncFaceLabelForFile(fileId);
    const undoId = recordUndo(
      fileId,
      previousTags,
      previousDescription,
      tagsForFile(fileId),
      description,
      previousFaces,
    );
    queueFaceProcessing(fileRowById(fileId) ?? row);
    return {
      detail: detailForFile(fileId)!,
      undoId,
      metadataWritable: written.metadataWritable,
    };
  });
}

export async function undoChange(undoId: number): Promise<FileDetail | null> {
  if (isWriteTaskRunning())
    throw new Error("Wait for the current task to finish before undoing");
  const entry = undoEntry(undoId);
  if (!entry || entry.undone === 1) return null;
  return withFileLock(entry.file_id, async () => {
    const row = fileRowById(entry.file_id);
    if (!row) return null;
    const absolute = absolutePathFor(row);
    if (!absolute) return null;
    const tags = JSON.parse(entry.previous_tags) as Tag[];
    const expectedTags = JSON.parse(entry.new_tags) as Tag[];
    const expectedDescription = entry.new_description ?? "";
    if (
      !tagsEqual(tagsForFile(entry.file_id), expectedTags) ||
      (row.description ?? "") !== expectedDescription
    ) {
      throw new Error(
        "This file changed after that save; the undo would overwrite newer edits.",
      );
    }
    const previousFaces = entry.previous_faces
      ? (JSON.parse(entry.previous_faces) as {
          id: number;
          label: string | null;
        }[])
      : [];
    const description = entry.previous_description ?? "";
    const written = await writeMetadata({
      relativePath: row.path,
      absolutePath: absolute,
      tags,
      description,
    });
    const stat = await fs.promises.stat(absolute);
    updateFileAfterWrite(entry.file_id, {
      description,
      tags,
      metadataWritable: written.metadataWritable,
      mtimeMs: Math.floor(stat.mtimeMs),
      size: stat.size,
      captureAt: written.captureAt ?? row.capture_at,
      localDate: written.localDate ?? row.local_date,
      legacyPending: hasLegacyTags(row.name, description),
    });
    reconcileFaceLabelsForFile(entry.file_id);
    syncFaceLabelForFile(entry.file_id);
    for (const face of previousFaces) {
      if (!face.label) continue;
      if (
        !tags.some(
          (tag) =>
            tag.key === "people" &&
            valueNorm(tag.value) === valueNorm(face.label!),
        )
      )
        continue;
      setFaceLabel(face.id, face.label, {
        source: "tag-sync",
        confidence: 1,
      });
    }
    invalidateKnownFaces();
    markUndone(undoId);
    return detailForFile(entry.file_id);
  });
}

export type TagJobResult = {
  started: boolean;
  updated: number;
  reason?: string;
};

function jobConflict(): string | null {
  if (isTaskRunning()) return "Wait for the current task to finish";
  if (indexState.running) return "Wait for the library index to finish";
  return null;
}

/** Rewrite metadata for affected files without keeping the HTTP request open. */
async function persistTagsForFiles(
  fileIds: number[],
  label: string,
): Promise<void> {
  let errors = 0;
  for (let index = 0; index < fileIds.length; index++) {
    const fileId = fileIds[index]!;
    try {
      await withFileLock(fileId, async () => {
        const file = fileRowById(fileId);
        if (!file) return;
        const absolute = absolutePathFor(file);
        if (!absolute) return;
        const tags = tagsForFile(fileId);
        const written = await writeMetadata({
          relativePath: file.path,
          absolutePath: absolute,
          tags,
          description: file.description ?? "",
        });
        const stat = await fs.promises.stat(absolute);
        updateFileAfterWrite(fileId, {
          description: file.description ?? "",
          tags,
          metadataWritable: written.metadataWritable,
          mtimeMs: Math.floor(stat.mtimeMs),
          size: stat.size,
          captureAt: written.captureAt ?? file.capture_at,
          localDate: written.localDate ?? file.local_date,
          legacyPending: hasLegacyTags(file.name, file.description ?? ""),
        });
      });
    } catch (error) {
      errors++;
      serverLog.warn("tag metadata rewrite failed", fileId, error);
    }
    updateTask({ processed: index + 1, errors });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  finishTask(
    errors,
    `${label}: ${fileIds.length} file${fileIds.length === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}`,
  );
}

export async function renameTagValue(
  key: string,
  oldValue: string,
  newValue: string,
): Promise<TagJobResult> {
  const cleanKey = normalizeKey(key);
  const cleanNew = normalizeValue(newValue);
  if (!isValidTag({ key: cleanKey, value: cleanNew }))
    throw new Error("Invalid tag value");
  const conflict = jobConflict();
  if (conflict) return { started: false, updated: 0, reason: conflict };
  const old = db
    .prepare("SELECT id FROM tags WHERE key = ? AND value_norm = ?")
    .get(cleanKey, valueNorm(oldValue)) as { id: number } | undefined;
  if (!old) return { started: true, updated: 0 };
  const fileRows = db
    .prepare("SELECT file_id FROM file_tags WHERE tag_id = ?")
    .all(old.id) as { file_id: number }[];
  const task = beginTask("tag-rename", fileRows.length, `Renaming ${cleanKey}`);
  if (!task)
    return {
      started: false,
      updated: 0,
      reason: "Wait for the current task to finish",
    };
  try {
    const oldNorm = valueNorm(oldValue);
    const existingNew = db
      .prepare("SELECT id FROM tags WHERE key = ? AND value_norm = ?")
      .get(cleanKey, valueNorm(cleanNew)) as { id: number } | undefined;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (existingNew?.id === old.id) {
        // Case/spacing-only rename: the normalized value still points at the
        // same row. Keep all associations and only update the display value.
        db.prepare(
          "UPDATE tags SET value = ?, value_norm = ? WHERE id = ?",
        ).run(cleanNew, valueNorm(cleanNew), old.id);
      } else {
        let newId = existingNew?.id;
        if (newId) {
          for (const row of fileRows) {
            db.prepare(
              "INSERT OR IGNORE INTO file_tags(file_id, tag_id, source, created_at) VALUES(?, ?, ?, ?)",
            ).run(row.file_id, newId, "user", new Date().toISOString());
          }
          db.prepare(
            "UPDATE faces SET person_tag_id = ? WHERE person_tag_id = ?",
          ).run(newId, old.id);
          db.prepare("DELETE FROM file_tags WHERE tag_id = ?").run(old.id);
          db.prepare("DELETE FROM tags WHERE id = ?").run(old.id);
        } else {
          db.prepare(
            "UPDATE tags SET value = ?, value_norm = ? WHERE id = ?",
          ).run(cleanNew, valueNorm(cleanNew), old.id);
          newId = old.id;
        }
      }
      db.prepare(
        "DELETE FROM automation_suggestions WHERE key = ? AND value_norm = ?",
      ).run(cleanKey, oldNorm);
      db.prepare(
        "DELETE FROM suggestion_feedback WHERE key = ? AND value_norm = ?",
      ).run(cleanKey, oldNorm);
      db.prepare("DELETE FROM migration_map WHERE key = ? AND value = ?").run(
        cleanKey,
        normalizeValue(oldValue),
      );
      for (const row of fileRows) {
        updateFts(row.file_id);
        bumpTagsRevision(row.file_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    finishTask(
      1,
      `Rename failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }

  if (fileRows.length === 0) {
    finishTask(0, `Renamed ${cleanKey} (no files used it)`);
  } else {
    void persistTagsForFiles(
      fileRows.map((row) => row.file_id),
      `Renamed ${cleanKey}`,
    );
  }
  invalidateKnownFaces();
  return { started: true, updated: fileRows.length };
}

export function tagKeys() {
  return tagKeyList();
}

export function tagValues() {
  return allTagValues();
}

export function updateKey(key: string, multiValue: boolean) {
  const clean = normalizeKey(key);
  if (!TAG_KEY_RE.test(clean)) throw new Error("Invalid tag key");
  setTagKey(clean, multiValue);
}

export async function removeTagEverywhere(
  key: string,
  value: string,
): Promise<TagJobResult> {
  const conflict = jobConflict();
  if (conflict) return { started: false, updated: 0, reason: conflict };
  const cleanKey = normalizeKey(key);
  const row = db
    .prepare("SELECT id FROM tags WHERE key = ? AND value_norm = ?")
    .get(cleanKey, valueNorm(value)) as { id: number } | undefined;
  if (!row) return { started: true, updated: 0 };
  const files = db
    .prepare("SELECT file_id FROM file_tags WHERE tag_id = ?")
    .all(row.id) as { file_id: number }[];
  if (
    !beginTask(
      "tag-remove",
      files.length,
      `Removing ${cleanKey}=${normalizeValue(value)}`,
    )
  ) {
    return {
      started: false,
      updated: 0,
      reason: "Wait for the current task to finish",
    };
  }
  try {
    const oldNorm = valueNorm(value);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM tags WHERE id = ?").run(row.id);
      db.prepare(
        "DELETE FROM automation_suggestions WHERE key = ? AND value_norm = ?",
      ).run(cleanKey, oldNorm);
      db.prepare(
        "DELETE FROM suggestion_feedback WHERE key = ? AND value_norm = ?",
      ).run(cleanKey, oldNorm);
      db.prepare("DELETE FROM migration_map WHERE key = ? AND value = ?").run(
        cleanKey,
        normalizeValue(value),
      );
      for (const file of files) {
        updateFts(file.file_id);
        bumpTagsRevision(file.file_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    finishTask(
      1,
      `Remove failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  if (files.length === 0) {
    finishTask(0, `Removed ${cleanKey} (no files used it)`);
  } else {
    void persistTagsForFiles(
      files.map((file) => file.file_id),
      `Removed ${cleanKey}`,
    );
  }
  invalidateKnownFaces();
  return { started: true, updated: files.length };
}

/** Replace a file's tags in the local index only. Used by imports and tests. */
export function importTags(fileId: number, tags: Tag[]): void {
  replaceFileTags(fileId, tags, "import");
}
