import fs from "node:fs";
import path from "node:path";
import type { MigrationState, MigrationTagRow, Tag } from "../shared/types";
import {
  dedupeTags,
  isValidTag,
  normalizeKey,
  normalizeValue,
  parseLegacyFilename,
  splitLegacyDescription,
} from "../shared/tag-format";
import { config, serverLog } from "./config";
import {
  db,
  fileRowsWithLegacy,
  getMediaRoot,
  getSetting,
  setSetting,
  tagsForFile,
  transaction,
  updateFileAfterWrite,
  updateFilePath,
} from "./db";
import { absolutePathFor } from "./media";
import { writeMetadata } from "./metadata";

export const migrationState: MigrationState & {
  processed: number;
  total: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
} = {
  scanned: false,
  legacyFiles: 0,
  legacyTags: 0,
  appliedFiles: 0,
  pendingFiles: 0,
  running: false,
  errors: 0,
  processed: 0,
  total: 0,
  startedAt: null,
  finishedAt: null,
  lastError: null,
};

export function scanMigration(): MigrationState {
  const root = getMediaRoot();
  if (!root || !fs.existsSync(root))
    throw new Error("Media root is not configured");
  const files = db.prepare("SELECT id, name, description FROM files").all() as {
    id: number;
    name: string;
    description: string | null;
  }[];
  const collected = new Map<
    string,
    { count: number; sources: Set<string>; samples: Set<string> }
  >();
  let legacyFiles = 0;
  transaction(() => {
    db.prepare("DELETE FROM legacy_tags").run();
    for (const file of files) {
      const filename = parseLegacyFilename(file.name);
      const description = splitLegacyDescription(file.description ?? "", {
        allowSingle: Boolean(filename),
        filenameTags: filename?.tags,
      });
      const tags = [...(filename?.tags ?? []), ...description.tags];
      const sources = new Set<string>();
      if (filename) sources.add("filename");
      if (description.tags.length > 0) sources.add("description");
      const pending = tags.length > 0;
      db.prepare("UPDATE files SET legacy_pending = ? WHERE id = ?").run(
        pending ? 1 : 0,
        file.id,
      );
      if (!pending) continue;
      legacyFiles++;
      for (const tag of tags) {
        const entry = collected.get(tag) ?? {
          count: 0,
          sources: new Set<string>(),
          samples: new Set<string>(),
        };
        entry.count++;
        for (const source of sources) entry.sources.add(source);
        if (entry.samples.size < 5) entry.samples.add(String(file.id));
        collected.set(tag, entry);
      }
    }
    for (const [value, entry] of collected) {
      db.prepare(
        "INSERT INTO legacy_tags(legacy_value, count, sources, samples) VALUES(?, ?, ?, ?)",
      ).run(
        value,
        entry.count,
        JSON.stringify(Array.from(entry.sources)),
        JSON.stringify(Array.from(entry.samples)),
      );
    }
  });
  setSetting("migrationScanned", "true");
  migrationState.scanned = true;
  migrationState.legacyFiles = legacyFiles;
  migrationState.legacyTags = collected.size;
  migrationState.pendingFiles = legacyFiles;
  refreshMigrationCounters();
  return getMigrationState();
}

export function refreshMigrationCounters(): void {
  const pending = db
    .prepare("SELECT COUNT(*) AS count FROM files WHERE legacy_pending = 1")
    .get() as { count: number };
  const legacyTags = db
    .prepare("SELECT COUNT(*) AS count FROM legacy_tags")
    .get() as { count: number };
  migrationState.pendingFiles = pending.count;
  migrationState.legacyTags = legacyTags.count;
  migrationState.legacyFiles = pending.count;
  migrationState.scanned =
    getSetting("migrationScanned") === "true" || pending.count > 0;
}

export function getMigrationState(): MigrationState {
  refreshMigrationCounters();
  return {
    scanned: migrationState.scanned,
    legacyFiles: migrationState.legacyFiles,
    legacyTags: migrationState.legacyTags,
    appliedFiles: migrationState.appliedFiles,
    pendingFiles: migrationState.pendingFiles,
    running: migrationState.running,
    errors: migrationState.errors,
    processed: migrationState.processed,
    total: migrationState.total,
  };
}

export function getMigrationRows(): MigrationTagRow[] {
  const rows = db
    .prepare(
      "SELECT legacy_value, count, sources, samples FROM legacy_tags ORDER BY count DESC, legacy_value",
    )
    .all() as {
    legacy_value: string;
    count: number;
    sources: string;
    samples: string;
  }[];
  const mappingRows = db
    .prepare(
      "SELECT legacy_value, key, value, action FROM migration_map ORDER BY legacy_value, id",
    )
    .all() as {
    legacy_value: string;
    key: string;
    value: string;
    action: "map" | "skip";
  }[];
  return rows.map((row) => ({
    legacyValue: row.legacy_value,
    count: row.count,
    sources: JSON.parse(row.sources) as string[],
    samples: JSON.parse(row.samples) as string[],
    mapped: mappingRows
      .filter((mapping) => mapping.legacy_value === row.legacy_value)
      .map((mapping) => ({
        key: mapping.key,
        value: mapping.value,
        action: mapping.action,
      })),
  }));
}

export type MappingInput = {
  legacyValue: string;
  key: string;
  value: string;
  action: "map" | "skip";
}[];

export function setMappings(mappings: MappingInput): void {
  transaction(() => {
    db.prepare("DELETE FROM migration_map").run();
    for (const mapping of mappings) {
      if (mapping.action === "skip") {
        db.prepare(
          "INSERT OR IGNORE INTO migration_map(legacy_value, key, value, action) VALUES(?, ?, ?, ?)",
        ).run(mapping.legacyValue, "", "", "skip");
        continue;
      }
      const key = normalizeKey(mapping.key);
      const value = normalizeValue(mapping.value);
      if (!isValidTag({ key, value }))
        throw new Error(`Invalid mapping for '${mapping.legacyValue}'`);
      db.prepare(
        "INSERT OR IGNORE INTO migration_map(legacy_value, key, value, action) VALUES(?, ?, ?, ?)",
      ).run(mapping.legacyValue, key, value, "map");
    }
  });
}

function mappingsFor(legacyValue: string): MappingInput {
  return db
    .prepare(
      "SELECT legacy_value, key, value, action FROM migration_map WHERE legacy_value = ?",
    )
    .all(legacyValue) as MappingInput;
}

function mappedTags(legacyTags: string[]): { tags: Tag[]; complete: boolean } {
  const tags: Tag[] = [];
  let complete = true;
  for (const legacy of legacyTags) {
    const mappings = mappingsFor(legacy);
    if (mappings.length === 0) {
      complete = false;
      continue;
    }
    for (const mapping of mappings) {
      if (mapping.action === "map")
        tags.push({ key: mapping.key, value: mapping.value });
    }
  }
  return { tags: dedupeTags(tags), complete };
}

let applyPromise: Promise<void> | null = null;

export function applyMigration(options: { stripFilenames: boolean }): {
  started: boolean;
  state: MigrationState;
} {
  if (applyPromise) return { started: false, state: getMigrationState() };
  applyPromise = runMigrationApply(options).finally(() => {
    applyPromise = null;
  });
  return { started: true, state: getMigrationState() };
}

async function runMigrationApply(options: {
  stripFilenames: boolean;
}): Promise<void> {
  const root = getMediaRoot();
  if (!root) throw new Error("Media root is not configured");
  const rows = fileRowsWithLegacy();
  migrationState.running = true;
  migrationState.startedAt = new Date().toISOString();
  migrationState.finishedAt = null;
  migrationState.processed = 0;
  migrationState.total = rows.length;
  migrationState.errors = 0;
  migrationState.appliedFiles = 0;
  migrationState.lastError = null;
  serverLog.info("migration started", rows.length, "files");

  for (const row of rows) {
    migrationState.processed++;
    try {
      const filename = parseLegacyFilename(row.name);
      const descriptionParts = splitLegacyDescription(row.description ?? "", {
        allowSingle: Boolean(filename),
        filenameTags: filename?.tags,
      });
      const legacy = Array.from(
        new Set([...(filename?.tags ?? []), ...descriptionParts.tags]),
      );
      const mapped = mappedTags(legacy);
      if (!mapped.complete) {
        throw new Error(`unmapped legacy tag on ${row.path}`);
      }
      const absolute = absolutePathFor(row);
      if (!absolute) throw new Error("invalid path");
      const existingTags = tagsForFile(row.id);
      const nextTags = dedupeTags([...existingTags, ...mapped.tags]);
      const nextDescription =
        descriptionParts.tags.length > 0
          ? descriptionParts.description
          : (row.description ?? "");
      const written = await writeMetadata({
        relativePath: row.path,
        absolutePath: absolute,
        tags: nextTags,
        description: nextDescription,
      });
      if (!written.metadataWritable) throw new Error("metadata write failed");

      let newRelative = row.path;
      let newName = row.name;
      if (options.stripFilenames && filename) {
        const targetRelative = path.posix.join(
          path.posix.dirname(row.path) === "."
            ? ""
            : path.posix.dirname(row.path),
          filename.newName,
        );
        const targetAbsolute = path.resolve(root, targetRelative);
        if (targetAbsolute !== absolute && fs.existsSync(targetAbsolute)) {
          throw new Error(
            `cannot strip filename, target exists: ${targetRelative}`,
          );
        }
        if (targetAbsolute !== absolute) {
          await fs.promises.rename(absolute, targetAbsolute);
          await fs.promises
            .appendFile(
              path.join(config.migrationDir, "renames.jsonl"),
              JSON.stringify({
                fileId: row.id,
                from: row.path,
                to: targetRelative,
                at: new Date().toISOString(),
              }) + "\n",
            )
            .catch(() => undefined);
          newRelative = targetRelative;
          newName = filename.newName;
        }
      }
      const stat = await fs.promises.stat(path.resolve(root, newRelative));
      updateFileAfterWrite(row.id, {
        description: nextDescription,
        tags: nextTags,
        metadataWritable: true,
        mtimeMs: Math.floor(stat.mtimeMs),
        size: stat.size,
        captureAt: written.captureAt ?? row.capture_at,
        localDate: written.localDate ?? row.local_date,
        legacyPending: false,
      });
      if (newRelative !== row.path)
        updateFilePath(
          row.id,
          newRelative,
          newName,
          stat.size,
          Math.floor(stat.mtimeMs),
        );
      migrationState.appliedFiles++;
    } catch (error) {
      migrationState.errors++;
      migrationState.lastError =
        error instanceof Error ? error.message : String(error);
      serverLog.warn("migration file failed", row.path, error);
    }
  }
  migrationState.running = false;
  migrationState.finishedAt = new Date().toISOString();
  refreshMigrationCounters();
  serverLog.info(
    "migration complete",
    migrationState.appliedFiles,
    "applied",
    migrationState.errors,
    "errors",
  );
}

export function migrationReportPath(): string {
  return path.join(config.migrationDir, "report.json");
}

export async function writeMigrationReport(): Promise<void> {
  await fs.promises.mkdir(config.migrationDir, { recursive: true });
  await fs.promises.writeFile(
    migrationReportPath(),
    JSON.stringify(
      {
        state: migrationState,
        rows: getMigrationRows(),
      },
      null,
      2,
    ),
  );
}
