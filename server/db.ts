import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncClass } from "node:sqlite";
import path from "node:path";
import type { Tag, FileSummary, MediaKind } from "../shared/types";
import { dedupeTags, hasLegacyTags, valueNorm } from "../shared/tag-format";
import { config } from "./config";

// tsup/esbuild rewrites node:sqlite to "sqlite", which is not resolvable. Loading it
// through createRequire keeps the runtime specifier intact.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export type FileRow = {
  id: number;
  path: string;
  name: string;
  folder: string;
  ext: string;
  kind: MediaKind;
  size: number;
  mtime_ms: number;
  capture_at: string | null;
  local_date: string | null;
  gps_lat: number | null;
  gps_lon: number | null;
  camera: string | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  description: string | null;
  metadata_writable: number;
  legacy_pending: number;
  faces_processed: number;
  faces_attempts: number;
  tags_revision: number;
  scan_generation: number;
  indexed_at: string;
};

const schema = `
PRAGMA journal_mode = TRUNCATE;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  ext TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  capture_at TEXT,
  local_date TEXT,
  gps_lat REAL,
  gps_lon REAL,
  camera TEXT,
  width INTEGER,
  height INTEGER,
  duration_s REAL,
  description TEXT,
  metadata_writable INTEGER NOT NULL DEFAULT 1,
  legacy_pending INTEGER NOT NULL DEFAULT 0,
  faces_processed INTEGER NOT NULL DEFAULT 0,
  faces_attempts INTEGER NOT NULL DEFAULT 0,
  tags_revision INTEGER NOT NULL DEFAULT 0,
  scan_generation INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_local_date ON files(local_date);
CREATE INDEX IF NOT EXISTS idx_files_gps ON files(gps_lat, gps_lon);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder);
CREATE INDEX IF NOT EXISTS idx_files_legacy ON files(legacy_pending);
CREATE INDEX IF NOT EXISTS idx_files_capture ON files(capture_at);
CREATE INDEX IF NOT EXISTS idx_files_move ON files(size, mtime_ms);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  UNIQUE(key, value_norm)
);
CREATE INDEX IF NOT EXISTS idx_tags_key ON tags(key, value);

CREATE TABLE IF NOT EXISTS file_tags (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL,
  PRIMARY KEY(file_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);

CREATE TABLE IF NOT EXISTS tag_keys (
  key TEXT PRIMARY KEY,
  multi_value INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_batches (
  date TEXT PRIMARY KEY,
  goal INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_items (
  date TEXT NOT NULL REFERENCES daily_batches(date) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  done_at TEXT,
  PRIMARY KEY(date, file_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_items_status ON daily_items(date, status);

CREATE TABLE IF NOT EXISTS suggestion_feedback (
  date TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(date, file_id, key, value_norm)
);

CREATE TABLE IF NOT EXISTS undo_log (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  previous_tags TEXT NOT NULL,
  previous_description TEXT,
  new_tags TEXT NOT NULL,
  new_description TEXT,
  previous_faces TEXT,
  undone INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  bbox TEXT NOT NULL,
  embedding BLOB NOT NULL,
  person_tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  label_source TEXT,
  label_confidence REAL,
  quality REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faces_file ON faces(file_id);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_tag_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '{}',
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  auto_added INTEGER NOT NULL DEFAULT 0,
  review_added INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS face_label_events (
  id INTEGER PRIMARY KEY,
  face_id INTEGER NOT NULL REFERENCES faces(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  person_tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  confidence REAL,
  run_id INTEGER REFERENCES automation_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_face_label_events_face ON face_label_events(face_id);

CREATE TABLE IF NOT EXISTS automation_suggestions (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES automation_runs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  face_id INTEGER REFERENCES faces(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL DEFAULT 0,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  value_norm TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  distance_m REAL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE(kind, file_id, subject_id, key, value_norm)
);
CREATE INDEX IF NOT EXISTS idx_automation_suggestions_status
  ON automation_suggestions(status, kind, confidence);
CREATE INDEX IF NOT EXISTS idx_automation_suggestions_file
  ON automation_suggestions(file_id);

CREATE TABLE IF NOT EXISTS legacy_tags (
  legacy_value TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  sources TEXT NOT NULL,
  samples TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS migration_map (
  id INTEGER PRIMARY KEY,
  legacy_value TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  action TEXT NOT NULL,
  UNIQUE(legacy_value, key, value, action)
);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(name, description, tags);
`;

export const db = new DatabaseSync(config.dbPath);
db.exec(schema);

function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((entry) => entry.name === column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}
ensureColumn("faces", "label_source", "label_source TEXT");
ensureColumn("faces", "label_confidence", "label_confidence REAL");
ensureColumn(
  "files",
  "faces_attempts",
  "faces_attempts INTEGER NOT NULL DEFAULT 0",
);
ensureColumn(
  "files",
  "tags_revision",
  "tags_revision INTEGER NOT NULL DEFAULT 0",
);
ensureColumn("undo_log", "previous_faces", "previous_faces TEXT");

let tagMutationVersion = 0;

/** Bumped whenever any file/tag association changes. Suggestion caches watch this. */
export function currentTagMutationVersion(): number {
  return tagMutationVersion;
}

export function bumpTagMutationVersion(): void {
  tagMutationVersion++;
}

export function bumpTagsRevision(fileId: number): void {
  statement(
    "UPDATE files SET tags_revision = tags_revision + 1 WHERE id = ?",
  ).run(fileId);
  bumpTagMutationVersion();
}

const statementCache = new Map<
  string,
  ReturnType<DatabaseSyncClass["prepare"]>
>();
function statement(sql: string) {
  let cached = statementCache.get(sql);
  if (!cached) {
    cached = db.prepare(sql);
    statementCache.set(sql, cached);
  }
  return cached;
}

export function now(): string {
  return new Date().toISOString();
}

export function todayKey(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: getSetting("timezone") || config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getSetting(key: string): string | null {
  const row = statement("SELECT value FROM settings WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  statement(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = statement("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function ensureDefaults(): void {
  const defaults: Record<string, string> = {
    dailyGoal: String(config.dailyGoal),
    reminderTime: "19:00",
    timezone: config.timezone,
    suggestionRadiusM: String(config.suggestionRadiusM),
    facesEnabled: config.facesEnabled ? "true" : "false",
    faceScanMode: config.faceScanMode,
    faceAutoThreshold: String(config.faceAutoThreshold),
    faceAutoMargin: String(config.faceAutoMargin),
    faceMinQuality: String(config.faceMinQuality),
    placeAutoRadiusM: String(config.placeAutoRadiusM),
    placeReviewRadiusM: String(config.placeReviewRadiusM),
    reviewAutoTagged: "true",
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (getSetting(key) === null) setSetting(key, value);
  }
  const keys = [
    "people",
    "place",
    "event",
    "mood",
    "activity",
    "object",
    "keyword",
  ];
  keys.forEach((key, index) =>
    statement(
      "INSERT OR IGNORE INTO tag_keys(key, multi_value, sort) VALUES(?, ?, ?)",
    ).run(key, ["people", "activity", "object"].includes(key) ? 1 : 0, index),
  );
}

ensureDefaults();

export function getMediaRoot(): string | null {
  const configured = getSetting("mediaRoot") || config.envMediaRoot;
  if (!configured) return null;
  return path.resolve(configured);
}

export function setMediaRoot(value: string): void {
  setSetting("mediaRoot", path.resolve(value));
}

export function fileRowById(id: number): FileRow | null {
  return (
    (statement("SELECT * FROM files WHERE id = ?").get(id) as
      FileRow | undefined) ?? null
  );
}

export function fileRowByPath(relativePath: string): FileRow | null {
  return (
    (statement("SELECT * FROM files WHERE path = ?").get(relativePath) as
      FileRow | undefined) ?? null
  );
}

/** Best-effort detection of a moved/renamed file from the previous scan. */
export function findMovedFileRow(input: {
  size: number;
  mtimeMs: number;
  newPath: string;
  generation: number;
}): FileRow | null {
  const rows = statement(
    `SELECT * FROM files
     WHERE size = ? AND mtime_ms = ? AND path <> ? AND scan_generation <> ?
     LIMIT 2`,
  ).all(
    input.size,
    input.mtimeMs,
    input.newPath,
    input.generation,
  ) as FileRow[];
  return rows.length === 1 ? rows[0]! : null;
}

export function adoptFilePath(
  fileId: number,
  input: {
    relativePath: string;
    name: string;
    folder: string;
    ext: string;
    kind: MediaKind;
    description: string | null;
  },
): void {
  transaction(() => {
    statement(
      `UPDATE files SET path = ?, name = ?, folder = ?, ext = ?, kind = ?,
         legacy_pending = ?, indexed_at = ? WHERE id = ?`,
    ).run(
      input.relativePath,
      input.name,
      input.folder,
      input.ext,
      input.kind,
      hasLegacyTags(input.name, input.description ?? "") ? 1 : 0,
      now(),
      fileId,
    );
    updateFts(fileId);
  });
}

export function tagsForFile(fileId: number): Tag[] {
  return statement(
    `SELECT t.key, t.value, ft.source FROM tags t
     JOIN file_tags ft ON ft.tag_id = t.id
     WHERE ft.file_id = ?
     ORDER BY t.key, t.value`,
  ).all(fileId) as { key: string; value: string; source: string }[];
}

export function tagRowsForFiles(fileIds: number[]): Map<number, Tag[]> {
  const result = new Map<number, Tag[]>();
  if (fileIds.length === 0) return result;
  const placeholders = fileIds.map(() => "?").join(",");
  const rows = statement(
    `SELECT ft.file_id, t.key, t.value, ft.source FROM tags t
     JOIN file_tags ft ON ft.tag_id = t.id
     WHERE ft.file_id IN (${placeholders})
     ORDER BY t.key, t.value`,
  ).all(...fileIds) as {
    file_id: number;
    key: string;
    value: string;
    source: string;
  }[];
  for (const row of rows) {
    const list = result.get(row.file_id) ?? [];
    list.push({ key: row.key, value: row.value, source: row.source });
    result.set(row.file_id, list);
  }
  return result;
}

function upsertTag(tag: Tag): number {
  statement(
    "INSERT OR IGNORE INTO tag_keys(key, multi_value, sort) VALUES(?, 0, 0)",
  ).run(tag.key);
  const norm = valueNorm(tag.value);
  const inserted = statement(
    "INSERT OR IGNORE INTO tags(key, value, value_norm) VALUES(?, ?, ?)",
  ).run(tag.key, tag.value, norm);
  if (Number(inserted.changes) > 0) return Number(inserted.lastInsertRowid);
  const row = statement(
    "SELECT id FROM tags WHERE key = ? AND value_norm = ?",
  ).get(tag.key, norm) as { id: number } | undefined;
  if (!row) throw new Error(`Unable to store tag ${tag.key}=${tag.value}`);
  return row.id;
}

function replaceFileTagsUnsafe(
  fileId: number,
  tags: Tag[],
  source = "user",
): void {
  const clean = dedupeTags(tags);
  const desired = new Map<number, Tag>();
  for (const tag of clean) desired.set(upsertTag(tag), tag);

  const current = new Set(
    (
      statement("SELECT tag_id FROM file_tags WHERE file_id = ?").all(
        fileId,
      ) as { tag_id: number }[]
    ).map((row) => row.tag_id),
  );

  for (const tagId of current) {
    if (!desired.has(tagId)) {
      statement("DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?").run(
        fileId,
        tagId,
      );
    }
  }
  for (const tagId of desired.keys()) {
    if (!current.has(tagId)) {
      statement(
        "INSERT OR IGNORE INTO file_tags(file_id, tag_id, source, created_at) VALUES(?, ?, ?, ?)",
      ).run(fileId, tagId, source, now());
    }
  }
  updateFts(fileId);
  bumpTagsRevision(fileId);
}

export function replaceFileTags(
  fileId: number,
  tags: Tag[],
  source = "user",
): void {
  transaction(() => replaceFileTagsUnsafe(fileId, tags, source));
}

export function addFaceTag(fileId: number, person: string): void {
  const existing = tagsForFile(fileId);
  replaceFileTags(
    fileId,
    [...existing, { key: "people", value: person }],
    "face",
  );
}

export function addTagToFile(fileId: number, tag: Tag, source = "user"): void {
  replaceFileTags(fileId, [...tagsForFile(fileId), tag], source);
}

/** Promote a tag (and matching face label) to a trusted source. */
export function promoteFileTagSource(
  fileId: number,
  key: string,
  value: string,
  source: string,
): boolean {
  const row = statement(
    `SELECT t.id AS tag_id FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
     WHERE ft.file_id = ? AND t.key = ? AND t.value_norm = ?`,
  ).get(fileId, key, valueNorm(value)) as { tag_id: number } | undefined;
  if (!row) return false;
  statement(
    "UPDATE file_tags SET source = ? WHERE file_id = ? AND tag_id = ?",
  ).run(source, fileId, row.tag_id);
  if (key === "people") {
    statement(
      "UPDATE faces SET label_source = ? WHERE file_id = ? AND person_tag_id = ? AND label_source = 'face-auto'",
    ).run(source, fileId, row.tag_id);
  }
  bumpTagsRevision(fileId);
  return true;
}

/** Remove a tag only when it was added by the expected subsystem. */
export function removeTagFromFileIfSource(
  fileId: number,
  tag: Tag,
  source: string,
): boolean {
  const row = statement(
    `SELECT ft.tag_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id
     WHERE ft.file_id = ? AND t.key = ? AND t.value_norm = ? AND ft.source = ?
     LIMIT 1`,
  ).get(fileId, tag.key, valueNorm(tag.value), source) as
    { tag_id: number } | undefined;
  if (!row) return false;
  transaction(() => {
    statement("DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?").run(
      fileId,
      row.tag_id,
    );
    updateFts(fileId);
    bumpTagsRevision(fileId);
  });
  return true;
}

export function updateFts(fileId: number): void {
  const file = fileRowById(fileId);
  if (!file) return;
  const tags = tagsForFile(fileId);
  const text = tags
    .map((tag) => `${tag.key}=${tag.value} ${tag.value}`)
    .join(" ");
  statement("DELETE FROM files_fts WHERE rowid = ?").run(fileId);
  statement(
    "INSERT INTO files_fts(rowid, name, description, tags) VALUES(?, ?, ?, ?)",
  ).run(fileId, file.name, file.description ?? "", text);
}

export type UpsertFileInput = {
  relativePath: string;
  name: string;
  folder: string;
  ext: string;
  kind: MediaKind;
  size: number;
  mtimeMs: number;
  captureAt: string | null;
  localDate: string | null;
  gps: { lat: number; lon: number } | null;
  camera: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  description: string | null;
  tags: Tag[];
  metadataWritable: boolean;
  legacyPending: boolean;
  scanGeneration: number;
};

export function upsertFile(input: UpsertFileInput): number {
  return transaction(() => {
    statement(
      `INSERT INTO files(
        path, name, folder, ext, kind, size, mtime_ms, capture_at, local_date,
        gps_lat, gps_lon, camera, width, height, duration_s, description,
        metadata_writable, legacy_pending, scan_generation, indexed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        name = excluded.name,
        folder = excluded.folder,
        ext = excluded.ext,
        kind = excluded.kind,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        capture_at = excluded.capture_at,
        local_date = excluded.local_date,
        gps_lat = excluded.gps_lat,
        gps_lon = excluded.gps_lon,
        camera = excluded.camera,
        width = excluded.width,
        height = excluded.height,
        duration_s = excluded.duration_s,
        description = excluded.description,
        metadata_writable = excluded.metadata_writable,
        legacy_pending = excluded.legacy_pending,
        faces_processed = 0,
        faces_attempts = 0,
        scan_generation = excluded.scan_generation,
        indexed_at = excluded.indexed_at`,
    ).run(
      input.relativePath,
      input.name,
      input.folder,
      input.ext,
      input.kind,
      input.size,
      input.mtimeMs,
      input.captureAt,
      input.localDate,
      input.gps?.lat ?? null,
      input.gps?.lon ?? null,
      input.camera,
      input.width,
      input.height,
      input.duration,
      input.description,
      input.metadataWritable ? 1 : 0,
      input.legacyPending ? 1 : 0,
      input.scanGeneration,
      now(),
    );
    const row = statement("SELECT id FROM files WHERE path = ?").get(
      input.relativePath,
    ) as { id: number };
    // Keep face rows across reindexing. They are replaced after the file is
    // reprocessed, and labelled faces can be matched back by embedding.
    replaceFileTagsUnsafe(row.id, input.tags, "import");
    return row.id;
  });
}

export function updateFileAfterWrite(
  fileId: number,
  input: {
    description: string;
    tags: Tag[];
    metadataWritable: boolean;
    mtimeMs: number;
    size?: number;
    captureAt: string | null;
    localDate: string | null;
    legacyPending: boolean;
  },
): void {
  transaction(() => {
    statement(
      `UPDATE files SET description = ?, metadata_writable = ?, mtime_ms = ?, size = COALESCE(?, size), capture_at = ?, local_date = ?, legacy_pending = ?, indexed_at = ? WHERE id = ?`,
    ).run(
      input.description,
      input.metadataWritable ? 1 : 0,
      input.mtimeMs,
      input.size ?? null,
      input.captureAt,
      input.localDate,
      input.legacyPending ? 1 : 0,
      now(),
      fileId,
    );
    replaceFileTagsUnsafe(fileId, input.tags, "user");
  });
}

export function markFileTagged(fileId: number): void {
  statement("UPDATE files SET legacy_pending = 0 WHERE id = ?").run(fileId);
}

export function updateFilePath(
  fileId: number,
  relativePath: string,
  name: string,
  size: number,
  mtimeMs: number,
): void {
  transaction(() => {
    statement(
      "UPDATE files SET path = ?, name = ?, size = ?, mtime_ms = ?, indexed_at = ? WHERE id = ?",
    ).run(relativePath, name, size, mtimeMs, now(), fileId);
    updateFts(fileId);
  });
}

export function fileRowsWithLegacy(): FileRow[] {
  return statement(
    "SELECT * FROM files WHERE legacy_pending = 1 ORDER BY path",
  ).all() as FileRow[];
}

export function deleteMissingFiles(scanGeneration: number): {
  fileIds: number[];
  faceIds: number[];
} {
  const ids = statement("SELECT id FROM files WHERE scan_generation <> ?").all(
    scanGeneration,
  ) as { id: number }[];
  const fileIds = ids.map((row) => row.id);
  const faceIds = fileIds.length
    ? (
        statement(
          `SELECT id FROM faces WHERE file_id IN (${fileIds.map(() => "?").join(",")})`,
        ).all(...fileIds) as { id: number }[]
      ).map((row) => row.id)
    : [];
  transaction(() => {
    statement("DELETE FROM files WHERE scan_generation <> ?").run(
      scanGeneration,
    );
    for (const row of ids)
      statement("DELETE FROM files_fts WHERE rowid = ?").run(row.id);
  });
  return { fileIds, faceIds };
}

export function touchFileScan(fileId: number, scanGeneration: number): void {
  statement("UPDATE files SET scan_generation = ? WHERE id = ?").run(
    scanGeneration,
    fileId,
  );
}

export function nextScanGeneration(): number {
  const row = statement(
    "SELECT COALESCE(MAX(scan_generation), 0) + 1 AS value FROM files",
  ).get() as {
    value: number;
  };
  return row.value;
}

export function countManuallyTaggedFiles(): number {
  return (
    statement(
      "SELECT COUNT(DISTINCT ft.file_id) AS count FROM file_tags ft WHERE ft.source NOT IN ('face-auto', 'place-auto')",
    ).get() as { count: number }
  ).count;
}

export function countAutoOnlyFiles(): number {
  return (
    statement(
      `SELECT COUNT(*) AS count FROM files f
       WHERE EXISTS (
         SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id
           AND ft.source IN ('face-auto', 'place-auto')
       )
       AND NOT EXISTS (
         SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id
           AND ft.source NOT IN ('face-auto', 'place-auto')
       )`,
    ).get() as { count: number }
  ).count;
}

export function countNeedsReviewFiles(): number {
  return (
    statement(
      `SELECT COUNT(*) AS count FROM files f
       WHERE f.legacy_pending = 0
         AND NOT EXISTS (
           SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id
             AND ft.source NOT IN ('face-auto', 'place-auto')
         )`,
    ).get() as { count: number }
  ).count;
}

export function fileIsAutoOnly(fileId: number): boolean {
  const rows = statement("SELECT source FROM file_tags WHERE file_id = ?").all(
    fileId,
  ) as { source: string }[];
  return (
    rows.length > 0 &&
    rows.every(
      (row) => row.source === "face-auto" || row.source === "place-auto",
    )
  );
}

export function promoteAutoTagsForFile(fileId: number): number {
  const result = statement(
    "UPDATE file_tags SET source = 'review' WHERE file_id = ? AND source IN ('face-auto', 'place-auto')",
  ).run(fileId);
  statement(
    "UPDATE faces SET label_source = 'review' WHERE file_id = ? AND label_source = 'face-auto'",
  ).run(fileId);
  if (Number(result.changes) > 0) bumpTagsRevision(fileId);
  return Number(result.changes);
}

export function countFiles(filter?: {
  untagged?: boolean;
  legacyPending?: boolean;
}): number {
  let sql = "SELECT COUNT(*) AS count FROM files f";
  const params: (string | number)[] = [];
  if (filter?.untagged)
    sql +=
      " WHERE NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id)";
  if (filter?.legacyPending) {
    sql += filter?.untagged ? " AND" : " WHERE";
    sql += " f.legacy_pending = 1";
  }
  const row = statement(sql).get(...params) as { count: number };
  return row.count;
}

export type FileListFilter = {
  q?: string;
  tagged?: boolean;
  untagged?: boolean;
  legacyPending?: boolean;
  key?: string;
  value?: string;
  cursor?: string;
  limit?: number;
  sort?: "newest" | "oldest" | "name";
};

export function fileListCursor(
  row: FileRow,
  sort: "newest" | "oldest" | "name" = "newest",
): string {
  if (sort === "oldest") {
    const value = row.capture_at ?? row.indexed_at;
    return `oldest:${encodeURIComponent(value)}:${row.id}`;
  }
  if (sort === "name") {
    return `name:${encodeURIComponent(row.name)}:${row.id}`;
  }
  return `newest:${row.id}`;
}

function parseFileListCursor(cursor: string): {
  sort: string;
  value: string;
  id: number;
} | null {
  const first = cursor.indexOf(":");
  if (first < 0) return null;
  const sort = cursor.slice(0, first);
  const rest = cursor.slice(first + 1);
  if (sort === "newest") {
    const id = Number.parseInt(rest, 10);
    return Number.isFinite(id) ? { sort, value: "", id } : null;
  }
  const last = rest.lastIndexOf(":");
  if (last < 0) return null;
  let value: string;
  try {
    value = decodeURIComponent(rest.slice(0, last));
  } catch {
    return null;
  }
  const id = Number.parseInt(rest.slice(last + 1), 10);
  return Number.isFinite(id) ? { sort, value, id } : null;
}

export function listFileRows(filter: FileListFilter): FileRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (filter.tagged)
    conditions.push(
      "EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id)",
    );
  if (filter.untagged)
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id)",
    );
  if (filter.legacyPending) conditions.push("f.legacy_pending = 1");
  if (filter.key && filter.value) {
    conditions.push(
      "EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id AND t.key = ? AND t.value_norm = ?)",
    );
    params.push(filter.key, valueNorm(filter.value));
  } else if (filter.key) {
    conditions.push(
      "EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id AND t.key = ?)",
    );
    params.push(filter.key);
  }
  if (filter.q) {
    const terms = filter.q
      .split(/\s+/)
      .map((term) => term.replace(/[^\p{L}\p{N}_-]/gu, ""))
      .filter(Boolean);
    if (terms.length > 0) {
      conditions.push(
        "f.id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)",
      );
      params.push(terms.map((term) => `"${term}"*`).join(" AND "));
    }
  }
  const sort = filter.sort ?? "newest";
  const cursor = filter.cursor ? parseFileListCursor(filter.cursor) : null;
  if (cursor && cursor.sort === sort) {
    if (sort === "oldest") {
      conditions.push(
        "(COALESCE(f.capture_at, f.indexed_at) > ? OR (COALESCE(f.capture_at, f.indexed_at) = ? AND f.id > ?))",
      );
      params.push(cursor.value, cursor.value, cursor.id);
    } else if (sort === "name") {
      conditions.push(
        "(f.name COLLATE NOCASE > ? OR (f.name COLLATE NOCASE = ? AND f.id > ?))",
      );
      params.push(cursor.value, cursor.value, cursor.id);
    } else {
      conditions.push("f.id < ?");
      params.push(cursor.id);
    }
  }
  const order =
    sort === "oldest"
      ? "COALESCE(f.capture_at, f.indexed_at) ASC, f.id ASC"
      : sort === "name"
        ? "f.name COLLATE NOCASE ASC, f.id ASC"
        : "f.id DESC";
  const limit = Math.max(1, Math.min(201, filter.limit ?? 40));
  const sql = `SELECT f.* FROM files f ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${order} LIMIT ?`;
  return statement(sql).all(...params, limit) as FileRow[];
}

export function summaryFromRow(
  row: FileRow,
  tags: Tag[] = tagsForFile(row.id),
): FileSummary {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    folder: row.folder,
    kind: row.kind,
    size: row.size,
    captureAt: row.capture_at,
    localDate: row.local_date,
    gps:
      row.gps_lat !== null && row.gps_lon !== null
        ? { lat: row.gps_lat, lon: row.gps_lon }
        : null,
    tags,
    tagsRevision: row.tags_revision,
    legacyPending: row.legacy_pending === 1,
    thumbUrl: `/api/files/${row.id}/thumb?v=${row.mtime_ms}`,
    previewUrl: `/api/files/${row.id}/preview?v=${row.mtime_ms}`,
    mediaUrl: `/api/files/${row.id}/media?v=${row.mtime_ms}`,
  };
}

export function getBatch(
  date: string,
): { goal: number; items: { file_id: number; status: string }[] } | null {
  const batch = statement("SELECT goal FROM daily_batches WHERE date = ?").get(
    date,
  ) as { goal: number } | undefined;
  if (!batch) return null;
  const items = statement(
    "SELECT file_id, status FROM daily_items WHERE date = ? ORDER BY position",
  ).all(date) as {
    file_id: number;
    status: string;
  }[];
  return { goal: batch.goal, items };
}

export function createBatch(
  date: string,
  goal: number,
  fileIds: number[],
): void {
  transaction(() => {
    statement(
      "INSERT INTO daily_batches(date, goal, created_at) VALUES(?, ?, ?)",
    ).run(date, goal, now());
    fileIds.forEach((fileId, index) =>
      statement(
        "INSERT INTO daily_items(date, file_id, position, status) VALUES(?, ?, ?, ?)",
      ).run(date, fileId, index, "pending"),
    );
  });
}

export function appendBatchItems(date: string, fileIds: number[]): void {
  const row = statement(
    "SELECT COALESCE(MAX(position), -1) AS maxPosition FROM daily_items WHERE date = ?",
  ).get(date) as {
    maxPosition: number;
  };
  transaction(() => {
    fileIds.forEach((fileId, index) =>
      statement(
        "INSERT OR IGNORE INTO daily_items(date, file_id, position, status) VALUES(?, ?, ?, ?)",
      ).run(date, fileId, row.maxPosition + index + 1, "pending"),
    );
  });
}

export function setBatchItemStatus(
  date: string,
  fileId: number,
  status: "done" | "skipped" | "pending",
): void {
  statement(
    "UPDATE daily_items SET status = ?, done_at = ? WHERE date = ? AND file_id = ?",
  ).run(status, status === "pending" ? null : now(), date, fileId);
}

export function batchItems(
  date: string,
): { file_id: number; status: string; position: number }[] {
  return statement(
    "SELECT file_id, status, position FROM daily_items WHERE date = ? ORDER BY position",
  ).all(date) as {
    file_id: number;
    status: string;
    position: number;
  }[];
}

function candidateTagCondition(includeAuto: boolean): string {
  return includeAuto
    ? "NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id AND ft.source NOT IN ('face-auto', 'place-auto'))"
    : "NOT EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id)";
}

export function untaggedCandidateRows(
  limit: number,
  excludeIds: number[] = [],
  includeAuto = true,
): FileRow[] {
  const placeholders = excludeIds.map(() => "?").join(",");
  const exclusion = excludeIds.length
    ? `AND f.id NOT IN (${placeholders})`
    : "";
  return statement(
    `SELECT f.* FROM files f
     WHERE f.legacy_pending = 0
       AND ${candidateTagCondition(includeAuto)}
       ${exclusion}
     ORDER BY RANDOM()
     LIMIT ?`,
  ).all(...excludeIds, limit) as FileRow[];
}

export function candidateRowsForBatch(
  seed: FileRow,
  limit: number,
  excludeIds: number[] = [],
  includeAuto = true,
): FileRow[] {
  const placeholders = excludeIds.map(() => "?").join(",");
  const exclusion = excludeIds.length
    ? `AND f.id NOT IN (${placeholders})`
    : "";
  const rows: FileRow[] = [];
  if (seed.local_date) {
    rows.push(
      ...(statement(
        `SELECT f.* FROM files f WHERE f.legacy_pending = 0 AND f.local_date = ? AND f.id <> ? AND ${candidateTagCondition(includeAuto)} ${exclusion} ORDER BY RANDOM() LIMIT ?`,
      ).all(seed.local_date, seed.id, ...excludeIds, limit) as FileRow[]),
    );
  }
  if (rows.length < limit && seed.folder) {
    const remaining = limit - rows.length;
    rows.push(
      ...(statement(
        `SELECT f.* FROM files f WHERE f.legacy_pending = 0 AND f.folder = ? AND f.id <> ? AND ${candidateTagCondition(includeAuto)} ${exclusion} ORDER BY RANDOM() LIMIT ?`,
      ).all(seed.folder, seed.id, ...excludeIds, remaining) as FileRow[]),
    );
  }
  const unique = new Map(rows.map((row) => [row.id, row]));
  return Array.from(unique.values()).slice(0, limit);
}

export function autoOnlyCandidateRows(
  limit: number,
  excludeIds: number[] = [],
): FileRow[] {
  const placeholders = excludeIds.map(() => "?").join(",");
  const exclusion = excludeIds.length
    ? `AND f.id NOT IN (${placeholders})`
    : "";
  return statement(
    `SELECT f.* FROM files f
     WHERE f.legacy_pending = 0
       AND EXISTS (
         SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id
           AND ft.source IN ('face-auto', 'place-auto')
       )
       AND NOT EXISTS (
         SELECT 1 FROM file_tags ft WHERE ft.file_id = f.id
           AND ft.source NOT IN ('face-auto', 'place-auto')
       )
       ${exclusion}
     ORDER BY RANDOM()
     LIMIT ?`,
  ).all(...excludeIds, limit) as FileRow[];
}

export function nearbyFileRows(
  file: FileRow,
  radiusM: number,
  limit = 120,
): FileRow[] {
  if (file.gps_lat === null || file.gps_lon === null) return [];
  const latDelta = radiusM / 111_320;
  const lonDelta =
    radiusM /
    (111_320 * Math.max(0.2, Math.cos((file.gps_lat * Math.PI) / 180)));
  return statement(
    `SELECT * FROM files
     WHERE id <> ? AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
       AND gps_lat BETWEEN ? AND ? AND gps_lon BETWEEN ? AND ?
     LIMIT ?`,
  ).all(
    file.id,
    file.gps_lat - latDelta,
    file.gps_lat + latDelta,
    file.gps_lon - lonDelta,
    file.gps_lon + lonDelta,
    limit,
  ) as FileRow[];
}

export function sameDayFileRows(file: FileRow, limit = 150): FileRow[] {
  if (!file.local_date) return [];
  return statement(
    `SELECT * FROM files WHERE id <> ? AND local_date = ? AND EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = files.id AND ft.source NOT IN ('face-auto', 'place-auto')) LIMIT ?`,
  ).all(file.id, file.local_date, limit) as FileRow[];
}

export function sameFolderFileRows(file: FileRow, limit = 150): FileRow[] {
  if (!file.folder) return [];
  return statement(
    `SELECT * FROM files WHERE id <> ? AND folder = ? AND EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = files.id AND ft.source NOT IN ('face-auto', 'place-auto')) LIMIT ?`,
  ).all(file.id, file.folder, limit) as FileRow[];
}

export function sequenceFileRows(file: FileRow, limit = 20): FileRow[] {
  const stem = file.name.replace(/\.[^.]+$/, "");
  const numeric = stem.match(/^(.*?)(\d+)$/);
  if (!numeric) return [];
  const prefix = numeric[1] ?? "";
  const number = Number(numeric[2]);
  const rows = statement(
    `SELECT * FROM files WHERE folder = ? AND id <> ? AND name LIKE ? AND EXISTS (SELECT 1 FROM file_tags ft WHERE ft.file_id = files.id AND ft.source NOT IN ('face-auto', 'place-auto')) LIMIT ?`,
  ).all(file.folder, file.id, `${prefix}%`, 200) as FileRow[];
  return rows
    .map((row) => {
      const match = row.name.replace(/\.[^.]+$/, "").match(/^(.*?)(\d+)$/);
      return {
        row,
        distance:
          match && match[1] === prefix
            ? Math.abs(Number(match[2]) - number)
            : Number.POSITIVE_INFINITY,
      };
    })
    .filter((entry) => entry.distance <= 5)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => entry.row);
}

export function filesSharingTags(
  file: FileRow,
  tags: Tag[],
  limit = 80,
): FileRow[] {
  if (tags.length === 0) return [];
  const tagIds = (
    statement(
      `SELECT id FROM tags WHERE ${tags.map(() => "(key = ? AND value_norm = ?)").join(" OR ")}`,
    ).all(...tags.flatMap((tag) => [tag.key, valueNorm(tag.value)])) as {
      id: number;
    }[]
  ).map((row) => row.id);
  if (tagIds.length === 0) return [];
  return statement(
    `SELECT DISTINCT f.* FROM files f
     JOIN file_tags ft ON ft.file_id = f.id
     WHERE ft.tag_id IN (${tagIds.map(() => "?").join(",")}) AND f.id <> ?
       AND ft.source NOT IN ('face-auto', 'place-auto')
     LIMIT ?`,
  ).all(...tagIds, file.id, limit) as FileRow[];
}

export function globalTagCounts(
  limit = 60,
): { key: string; value: string; count: number; lastUsed: string }[] {
  return statement(
    `SELECT t.key, t.value, COUNT(*) AS count, MAX(ft.created_at) AS lastUsed
     FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
     WHERE ft.source NOT IN ('face-auto', 'place-auto')
     GROUP BY t.id ORDER BY count DESC, t.key, t.value LIMIT ?`,
  ).all(limit) as {
    key: string;
    value: string;
    count: number;
    lastUsed: string;
  }[];
}

export function recentTagCounts(
  days = 30,
  limit = 40,
): { key: string; value: string; count: number; lastUsed: string }[] {
  return statement(
    `SELECT t.key, t.value, COUNT(*) AS count, MAX(ft.created_at) AS lastUsed
     FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
     WHERE ft.created_at >= ? AND ft.source NOT IN ('face-auto', 'place-auto')
     GROUP BY t.id ORDER BY lastUsed DESC, count DESC LIMIT ?`,
  ).all(new Date(Date.now() - days * 86_400_000).toISOString(), limit) as {
    key: string;
    value: string;
    count: number;
    lastUsed: string;
  }[];
}

export function rejectSuggestion(
  date: string,
  fileId: number,
  key: string,
  value: string,
): void {
  statement(
    "INSERT OR REPLACE INTO suggestion_feedback(date, file_id, key, value_norm, action, created_at) VALUES(?, ?, ?, ?, ?, ?)",
  ).run(date, fileId, key, valueNorm(value), "rejected", now());
}

export function rejectedSuggestions(date: string, fileId: number): Set<string> {
  const rows = statement(
    "SELECT key, value_norm FROM suggestion_feedback WHERE date = ? AND file_id = ? AND action = ?",
  ).all(date, fileId, "rejected") as { key: string; value_norm: string }[];
  return new Set(rows.map((row) => `${row.key}\u0000${row.value_norm}`));
}

export function recordUndo(
  fileId: number,
  previousTags: Tag[],
  previousDescription: string,
  newTags: Tag[],
  newDescription: string,
  previousFaces?: string,
): number {
  const result = statement(
    "INSERT INTO undo_log(file_id, at, previous_tags, previous_description, new_tags, new_description, previous_faces) VALUES(?, ?, ?, ?, ?, ?, ?)",
  ).run(
    fileId,
    now(),
    JSON.stringify(previousTags),
    previousDescription,
    JSON.stringify(newTags),
    newDescription,
    previousFaces ?? null,
  );
  const id = Number(result.lastInsertRowid);
  statement("DELETE FROM undo_log WHERE id <= ?").run(id - 2000);
  return id;
}

export function undoEntry(id: number): {
  id: number;
  file_id: number;
  previous_tags: string;
  previous_description: string | null;
  new_tags: string;
  new_description: string | null;
  previous_faces: string | null;
  undone: number;
} | null {
  return (
    (statement(
      "SELECT id, file_id, previous_tags, previous_description, new_tags, new_description, previous_faces, undone FROM undo_log WHERE id = ?",
    ).get(id) as
      | {
          id: number;
          file_id: number;
          previous_tags: string;
          previous_description: string | null;
          new_tags: string;
          new_description: string | null;
          previous_faces: string | null;
          undone: number;
        }
      | undefined) ?? null
  );
}

export function markUndone(id: number): void {
  statement("UPDATE undo_log SET undone = 1 WHERE id = ?").run(id);
}

export function tagKeyList(): {
  key: string;
  multiValue: boolean;
  count: number;
}[] {
  const rows = statement(
    `SELECT tk.key, tk.multi_value AS multiValue,
       (SELECT COUNT(*) FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.key = tk.key) AS count
     FROM tag_keys tk ORDER BY tk.sort, tk.key`,
  ).all() as { key: string; multiValue: number; count: number }[];
  return rows.map((row) => ({
    key: row.key,
    multiValue: row.multiValue === 1,
    count: row.count,
  }));
}

export function allTagValues(): {
  key: string;
  value: string;
  count: number;
  autoCount: number;
}[] {
  return statement(
    `SELECT t.key, t.value, COUNT(*) AS count,
       SUM(CASE WHEN ft.source IN ('face-auto', 'place-auto') THEN 1 ELSE 0 END) AS autoCount
     FROM tags t
     JOIN file_tags ft ON ft.tag_id = t.id
     GROUP BY t.id ORDER BY t.key, count DESC`,
  ).all() as {
    key: string;
    value: string;
    count: number;
    autoCount: number;
  }[];
}

export function setTagKey(key: string, multiValue: boolean): void {
  statement(
    "INSERT INTO tag_keys(key, multi_value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET multi_value = excluded.multi_value",
  ).run(key, multiValue ? 1 : 0);
}

export function last30DaysActivity(): { date: string; done: number }[] {
  return statement(
    `SELECT date, COUNT(*) AS done FROM daily_items
     WHERE status = 'done' AND date >= ?
     GROUP BY date ORDER BY date`,
  ).all(todayKey(new Date(Date.now() - 29 * 86_400_000))) as {
    date: string;
    done: number;
  }[];
}

export function statsTotals(): {
  totalTagged: number;
  totalManuallyTagged: number;
  totalAutoOnly: number;
  totalFiles: number;
  legacyPending: number;
} {
  const totalTagged = (
    statement(
      "SELECT COUNT(DISTINCT file_id) AS count FROM file_tags",
    ).get() as { count: number }
  ).count;
  const totalFiles = (
    statement("SELECT COUNT(*) AS count FROM files").get() as { count: number }
  ).count;
  const legacyPending = (
    statement(
      "SELECT COUNT(*) AS count FROM files WHERE legacy_pending = 1",
    ).get() as { count: number }
  ).count;
  return {
    totalTagged,
    totalManuallyTagged: countManuallyTaggedFiles(),
    totalAutoOnly: countAutoOnlyFiles(),
    totalFiles,
    legacyPending,
  };
}

export function topKeys(limit = 8): { key: string; count: number }[] {
  return statement(
    `SELECT t.key, COUNT(*) AS count FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
     GROUP BY t.key ORDER BY count DESC LIMIT ?`,
  ).all(limit) as { key: string; count: number }[];
}

export function faceCount(): number {
  return (
    statement("SELECT COUNT(*) AS count FROM faces").get() as { count: number }
  ).count;
}

export type FaceRow = {
  id: number;
  file_id: number;
  bbox: string;
  embedding: Uint8Array;
  person_tag_id: number | null;
  label_source: string | null;
  label_confidence: number | null;
  quality: number;
  label: string | null;
};

export function facesForFile(fileId: number): FaceRow[] {
  return statement(
    `SELECT f.*, t.value AS label FROM faces f LEFT JOIN tags t ON t.id = f.person_tag_id WHERE f.file_id = ? ORDER BY f.quality DESC`,
  ).all(fileId) as FaceRow[];
}

export function markFacesFailed(fileId: number): void {
  statement(
    "UPDATE files SET faces_processed = 2, faces_attempts = faces_attempts + 1 WHERE id = ?",
  ).run(fileId);
}

export function resetFacesProcessed(fileId: number): void {
  statement(
    "UPDATE files SET faces_processed = 0, faces_attempts = 0 WHERE id = ?",
  ).run(fileId);
}

export function replaceFacesForFile(
  fileId: number,
  faces: {
    bbox: { x: number; y: number; w: number; h: number };
    embedding: number[];
    quality: number;
  }[],
): void {
  transaction(() => {
    statement("DELETE FROM faces WHERE file_id = ?").run(fileId);
    for (const face of faces) {
      const buffer = Buffer.from(new Float32Array(face.embedding).buffer);
      statement(
        "INSERT INTO faces(file_id, bbox, embedding, quality, created_at) VALUES(?, ?, ?, ?, ?)",
      ).run(fileId, JSON.stringify(face.bbox), buffer, face.quality, now());
    }
    statement(
      "UPDATE files SET faces_processed = 1, faces_attempts = 0 WHERE id = ?",
    ).run(fileId);
  });
}

export function setFaceLabel(
  faceId: number,
  person: string | null,
  options: {
    source?: string;
    confidence?: number | null;
    runId?: number | null;
  } = {},
): { fileId: number; personTagId: number | null } | null {
  const face = statement("SELECT file_id FROM faces WHERE id = ?").get(
    faceId,
  ) as { file_id: number } | undefined;
  if (!face) return null;
  const source = options.source ?? "manual";
  if (!person) {
    statement(
      "UPDATE faces SET person_tag_id = NULL, label_source = NULL, label_confidence = NULL WHERE id = ?",
    ).run(faceId);
    statement(
      "INSERT INTO face_label_events(face_id, file_id, person_tag_id, source, confidence, run_id, created_at) VALUES(?, ?, NULL, ?, NULL, ?, ?)",
    ).run(faceId, face.file_id, source, options.runId ?? null, now());
    return { fileId: face.file_id, personTagId: null };
  }
  const tagId = upsertTag({ key: "people", value: person });
  statement(
    "UPDATE faces SET person_tag_id = ?, label_source = ?, label_confidence = ? WHERE id = ?",
  ).run(tagId, source, options.confidence ?? null, faceId);
  statement(
    "INSERT INTO face_label_events(face_id, file_id, person_tag_id, source, confidence, run_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)",
  ).run(
    faceId,
    face.file_id,
    tagId,
    source,
    options.confidence ?? null,
    options.runId ?? null,
    now(),
  );
  return { fileId: face.file_id, personTagId: tagId };
}

export function labeledFaces(): (FaceRow & { file_path: string })[] {
  return statement(
    `SELECT f.*, t.value AS label, files.path AS file_path
     FROM faces f JOIN tags t ON t.id = f.person_tag_id JOIN files ON files.id = f.file_id
     WHERE f.person_tag_id IS NOT NULL
     ORDER BY f.quality DESC
     LIMIT 5000`,
  ).all() as (FaceRow & { file_path: string })[];
}

/** Labels that may be used to seed automation. Auto labels are intentionally excluded. */
export function referenceFaces(): (FaceRow & { file_path: string })[] {
  return statement(
    `SELECT f.*, t.value AS label, files.path AS file_path
     FROM faces f JOIN tags t ON t.id = f.person_tag_id JOIN files ON files.id = f.file_id
     WHERE f.person_tag_id IS NOT NULL
       AND COALESCE(f.label_source, 'manual') IN ('manual', 'tag-sync', 'review')
     ORDER BY f.quality DESC
     LIMIT 10000`,
  ).all() as (FaceRow & { file_path: string })[];
}

export function unknownFaces(): (FaceRow & {
  file_path: string;
  name: string;
})[] {
  return statement(
    `SELECT f.*, files.path AS file_path, files.name AS name FROM faces f JOIN files ON files.id = f.file_id
     WHERE f.person_tag_id IS NULL
     ORDER BY f.quality DESC
     LIMIT 800`,
  ).all() as (FaceRow & { file_path: string; name: string })[];
}

export function faceRowsForFileWithLabel(fileId: number): FaceRow[] {
  return facesForFile(fileId);
}

export function faceForId(
  faceId: number,
): (FaceRow & { file_path: string }) | null {
  return (
    (statement(
      `SELECT f.*, t.value AS label, files.path AS file_path FROM faces f
       LEFT JOIN tags t ON t.id = f.person_tag_id JOIN files ON files.id = f.file_id WHERE f.id = ?`,
    ).get(faceId) as (FaceRow & { file_path: string }) | undefined) ?? null
  );
}

export function filesForFaceIds(
  faceIds: number[],
): { face_id: number; file_id: number; path: string }[] {
  if (faceIds.length === 0) return [];
  return statement(
    `SELECT f.id AS face_id, f.file_id, files.path FROM faces f JOIN files ON files.id = f.file_id
     WHERE f.id IN (${faceIds.map(() => "?").join(",")})`,
  ).all(...faceIds) as { face_id: number; file_id: number; path: string }[];
}

export function pushSubscriptions(): {
  endpoint: string;
  subscription: string;
}[] {
  return statement(
    "SELECT endpoint, subscription FROM push_subscriptions",
  ).all() as {
    endpoint: string;
    subscription: string;
  }[];
}

export function savePushSubscription(
  endpoint: string,
  subscription: string,
): void {
  statement(
    `INSERT INTO push_subscriptions(endpoint, subscription, created_at, last_seen, failures) VALUES(?, ?, ?, ?, 0)
     ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription, last_seen = excluded.last_seen`,
  ).run(endpoint, subscription, now(), now());
}

export function deletePushSubscription(endpoint: string): void {
  statement("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

export function pushFailure(endpoint: string): void {
  statement(
    "UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?",
  ).run(endpoint);
}

export function suggestionFeedbackCount(): number {
  return (
    statement("SELECT COUNT(*) AS count FROM suggestion_feedback").get() as {
      count: number;
    }
  ).count;
}
