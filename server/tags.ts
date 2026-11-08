import fs from "node:fs";
import type { FileDetail, Tag } from "../shared/types";
import {
  TAG_KEY_RE,
  dedupeTags,
  hasLegacyTags,
  isValidTag,
  normalizeKey,
  normalizeValue,
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
  recordUndo,
  undoEntry,
  markUndone,
  tagKeyList,
  allTagValues,
  setTagKey,
} from "./db";
import { absolutePathFor } from "./media";
import { writeMetadata } from "./metadata";
import { faceListForFile, queueFaceProcessing } from "./faces";

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
): Promise<SaveResult> {
  const row = fileRowById(fileId);
  if (!row) throw new Error("file not found");
  const absolute = absolutePathFor(row);
  if (!absolute) throw new Error("file is outside the media root");
  const nextTags = dedupeTags(tags);
  for (const tag of nextTags) {
    if (!isValidTag(tag))
      throw new Error(`Invalid tag: ${tag.key}=${tag.value}`);
  }
  const previousTags = tagsForFile(fileId);
  const previousDescription = row.description ?? "";
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
  const undoId = recordUndo(
    fileId,
    previousTags,
    previousDescription,
    nextTags,
    description,
  );
  queueFaceProcessing(fileRowById(fileId) ?? row);
  return {
    detail: detailForFile(fileId)!,
    undoId,
    metadataWritable: written.metadataWritable,
  };
}

export async function undoChange(undoId: number): Promise<FileDetail | null> {
  const entry = undoEntry(undoId);
  if (!entry || entry.undone === 1) return null;
  const row = fileRowById(entry.file_id);
  if (!row) return null;
  const absolute = absolutePathFor(row);
  if (!absolute) return null;
  const tags = JSON.parse(entry.previous_tags) as Tag[];
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
  markUndone(undoId);
  return detailForFile(entry.file_id);
}

export async function renameTagValue(
  key: string,
  oldValue: string,
  newValue: string,
): Promise<number> {
  const cleanKey = normalizeKey(key);
  const cleanNew = normalizeValue(newValue);
  if (!isValidTag({ key: cleanKey, value: cleanNew }))
    throw new Error("Invalid tag value");
  const old = db
    .prepare("SELECT id FROM tags WHERE key = ? AND value_norm = ?")
    .get(cleanKey, valueNorm(oldValue)) as { id: number } | undefined;
  if (!old) return 0;
  const fileRows = db
    .prepare("SELECT file_id FROM file_tags WHERE tag_id = ?")
    .all(old.id) as { file_id: number }[];
  const existingNew = db
    .prepare("SELECT id FROM tags WHERE key = ? AND value_norm = ?")
    .get(cleanKey, valueNorm(cleanNew)) as { id: number } | undefined;
  let newId = existingNew?.id;
  db.exec("BEGIN IMMEDIATE");
  try {
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
      db.prepare("UPDATE tags SET value = ?, value_norm = ? WHERE id = ?").run(
        cleanNew,
        valueNorm(cleanNew),
        old.id,
      );
      newId = old.id;
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  for (const row of fileRows) updateFts(row.file_id);
  for (const row of fileRows) {
    try {
      const file = fileRowById(row.file_id);
      if (!file) continue;
      const absolute = absolutePathFor(file);
      if (!absolute) continue;
      const tags = tagsForFile(row.file_id);
      const written = await writeMetadata({
        relativePath: file.path,
        absolutePath: absolute,
        tags,
        description: file.description ?? "",
      });
      if (written.metadataWritable) {
        const stat = await fs.promises.stat(absolute);
        updateFileAfterWrite(row.file_id, {
          description: file.description ?? "",
          tags,
          metadataWritable: true,
          mtimeMs: Math.floor(stat.mtimeMs),
          size: stat.size,
          captureAt: written.captureAt ?? file.capture_at,
          localDate: written.localDate ?? file.local_date,
          legacyPending: hasLegacyTags(file.name, file.description ?? ""),
        });
      }
    } catch {
      // The DB merge is still usable; metadata can be retried on the next save.
    }
  }
  return fileRows.length;
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
): Promise<number> {
  const row = db
    .prepare("SELECT id FROM tags WHERE key = ? AND value_norm = ?")
    .get(normalizeKey(key), valueNorm(value)) as { id: number } | undefined;
  if (!row) return 0;
  const files = db
    .prepare("SELECT file_id FROM file_tags WHERE tag_id = ?")
    .all(row.id) as { file_id: number }[];
  db.prepare("DELETE FROM tags WHERE id = ?").run(row.id);
  for (const file of files) updateFts(file.file_id);
  for (const file of files) {
    const fileRow = fileRowById(file.file_id);
    if (!fileRow) continue;
    const absolute = absolutePathFor(fileRow);
    if (!absolute) continue;
    const tags = tagsForFile(file.file_id);
    try {
      const written = await writeMetadata({
        relativePath: fileRow.path,
        absolutePath: absolute,
        tags,
        description: fileRow.description ?? "",
      });
      const stat = await fs.promises.stat(absolute);
      updateFileAfterWrite(file.file_id, {
        description: fileRow.description ?? "",
        tags,
        metadataWritable: written.metadataWritable,
        mtimeMs: Math.floor(stat.mtimeMs),
        size: stat.size,
        captureAt: written.captureAt ?? fileRow.capture_at,
        localDate: written.localDate ?? fileRow.local_date,
        legacyPending: hasLegacyTags(fileRow.name, fileRow.description ?? ""),
      });
    } catch {
      // The DB change stands; metadata can be retried on the next save.
    }
  }
  return files.length;
}

/** Replace a file's tags in the local index only. Used by imports and tests. */
export function importTags(fileId: number, tags: Tag[]): void {
  replaceFileTags(fileId, tags, "import");
}
