import fs from "node:fs";
import path from "node:path";
import { config, isMediaExtension, mediaKind, serverLog } from "./config";
import { dedupeTags } from "../shared/tag-format";
import {
  db,
  deleteMissingFiles,
  adoptFilePath,
  fileRowByPath,
  findMovedFileRow,
  getMediaRoot,
  getSetting,
  nextScanGeneration,
  setSetting,
  tagsForFile,
  touchFileScan,
  upsertFile,
  type FileRow,
} from "./db";
import { readMetadata } from "./metadata";
import { cleanAssetCaches, cleanFaceThumbs } from "./media";
import {
  facesAvailable,
  labelUnambiguousPeopleFaces,
  queueFaceProcessing,
  reconcileFaceLabelsForFile,
} from "./faces";
import { withFileLock } from "./file-lock";
import { isTaskRunning } from "./tasks";

export type IndexState = {
  running: boolean;
  scanned: number;
  total: number;
  indexed: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
};

export const indexState: IndexState = {
  running: false,
  scanned: 0,
  total: 0,
  indexed: 0,
  errors: 0,
  startedAt: null,
  finishedAt: null,
};

type WalkEntry = {
  absolutePath: string;
  relativePath: string;
  name: string;
  stat: fs.Stats;
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".lifetagger",
  "@eadir",
  "#recycle",
  "$recycle.bin",
  "system volume information",
  ".thumbnails",
  ".trash",
]);

let walkErrors = 0;
let legacyChanged = false;

async function walk(
  root: string,
  relative = "",
  output: WalkEntry[] = [],
): Promise<WalkEntry[]> {
  const directory = relative ? path.join(root, relative) : root;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    walkErrors++;
    serverLog.warn("cannot read directory", directory, error);
    return output;
  }
  for (const entry of entries) {
    const rel = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name.toLowerCase()))
        continue;
      await walk(root, rel, output);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase().replace(/^\./, "");
    if (!isMediaExtension(ext)) continue;
    try {
      const stat = await fs.promises.stat(path.join(root, rel));
      output.push({
        absolutePath: path.join(root, rel),
        relativePath: rel,
        name: entry.name,
        stat,
      });
    } catch {
      // The file may disappear during the scan.
    }
  }
  return output;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item, index);
      // Let HTTP probes and other I/O run between files. Indexing a large
      // library otherwise keeps a near-continuous stream of synchronous
      // SQLite work on the event loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

let activeScan: Promise<void> | null = null;

export function scanMedia(): Promise<void> {
  if (activeScan) return activeScan;
  activeScan = doScan().finally(() => {
    activeScan = null;
  });
  return activeScan;
}

async function doScan(): Promise<void> {
  const root = getMediaRoot();
  if (!root) return;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    serverLog.warn("media root does not exist", root);
    return;
  }
  if (isTaskRunning()) {
    serverLog.info("index skipped because another task is running");
    return;
  }
  const generation = nextScanGeneration();
  indexState.running = true;
  indexState.scanned = 0;
  indexState.total = 0;
  indexState.indexed = 0;
  indexState.errors = 0;
  indexState.startedAt = new Date().toISOString();
  indexState.finishedAt = null;
  walkErrors = 0;
  legacyChanged = false;
  serverLog.info("indexing", root);
  try {
    const entries = await walk(root);
    indexState.total = entries.length;
    const adoptedIds = new Set<number>();
    await mapLimit(entries, config.indexConcurrency, async (entry) => {
      indexState.scanned++;
      try {
        const mtime = Math.floor(entry.stat.mtimeMs);
        const ext = path.extname(entry.name).toLowerCase().replace(/^\./, "");
        const folder =
          path.posix.dirname(entry.relativePath) === "."
            ? ""
            : path.posix.dirname(entry.relativePath);
        let existing = fileRowByPath(entry.relativePath);
        if (!existing) {
          const moved = findMovedFileRow({
            size: entry.stat.size,
            mtimeMs: mtime,
            newPath: entry.relativePath,
            generation,
          });
          if (moved && !adoptedIds.has(moved.id)) {
            const oldAbsolute = path.join(root, moved.path);
            if (!fs.existsSync(oldAbsolute)) {
              adoptedIds.add(moved.id);
              adoptFilePath(moved.id, {
                relativePath: entry.relativePath,
                name: entry.name,
                folder,
                ext,
                kind: mediaKind(ext),
                description: moved.description,
              });
              existing = fileRowByPath(entry.relativePath);
            }
          }
        }
        if (
          existing &&
          existing.size === entry.stat.size &&
          existing.mtime_ms === mtime
        ) {
          touchFileScan(existing.id, generation);
          return;
        }
        const processEntry = async () => {
          const meta = await readMetadata(
            entry.absolutePath,
            entry.relativePath,
          );
          if (existing) await cleanAssetCaches(existing.id);
          if (meta.legacyPending || existing?.legacy_pending === 1)
            legacyChanged = true;
          // Formats that cannot carry metadata keep their tags in the index.
          // Preserve those tags when the file is re-read or moved.
          const indexedTags =
            existing && existing.metadata_writable === 0
              ? tagsForFile(existing.id)
              : [];
          const mergedTags = dedupeTags([...meta.tags, ...indexedTags]);
          const fileId = upsertFile({
            relativePath: entry.relativePath,
            name: entry.name,
            folder,
            ext,
            kind: mediaKind(ext),
            size: entry.stat.size,
            mtimeMs: mtime,
            captureAt: meta.captureAt,
            localDate: meta.localDate,
            gps: meta.gps,
            camera: meta.camera,
            width: meta.width,
            height: meta.height,
            duration: meta.duration,
            description: meta.description,
            tags: mergedTags,
            metadataWritable: existing
              ? existing.metadata_writable === 1
              : true,
            legacyPending: meta.legacyPending,
            scanGeneration: generation,
          });
          reconcileFaceLabelsForFile(fileId);
          indexState.indexed++;
        };
        if (existing) await withFileLock(existing.id, processEntry);
        else await processEntry();
      } catch (error) {
        indexState.errors++;
        serverLog.warn("index failed", entry.relativePath, error);
      }
    });
    if (
      walkErrors === 0 &&
      indexState.errors === 0 &&
      (entries.length > 0 ||
        (
          db.prepare("SELECT COUNT(*) AS count FROM files").get() as {
            count: number;
          }
        ).count === 0)
    ) {
      const removed = deleteMissingFiles(generation);
      for (const id of removed.fileIds) await cleanAssetCaches(id);
      await cleanFaceThumbs(removed.faceIds);
    } else {
      if (walkErrors > 0) indexState.errors += walkErrors;
      if (entries.length === 0) {
        serverLog.warn(
          "media root returned no files; skipping missing-file cleanup to protect the index",
        );
      } else {
        serverLog.warn(
          "skipped missing-file cleanup because some entries could not be read",
        );
      }
    }
    if (legacyChanged) setSetting("migrationNeedsScan", "true");
    if (facesAvailable()) {
      // Seed the face matcher from already-tagged people. These are often the
      // imported/migrated photos that give new photos something to match.
      const peopleRows = db
        .prepare(
          `SELECT DISTINCT f.* FROM files f
           JOIN file_tags ft ON ft.file_id = f.id
           JOIN tags t ON t.id = ft.tag_id
           WHERE t.key = 'people' AND f.faces_processed = 0
           LIMIT 500`,
        )
        .all() as FileRow[];
      for (const row of peopleRows) queueFaceProcessing(row);
      if (getSetting("faceScanMode") === "background") {
        const pendingFaces = db
          .prepare("SELECT * FROM files WHERE faces_processed = 0 LIMIT 1000")
          .all() as FileRow[];
        for (const row of pendingFaces) queueFaceProcessing(row);
      }
    }
    const labeled = labelUnambiguousPeopleFaces();
    if (labeled > 0)
      serverLog.info(`auto-labeled ${labeled} unambiguous face(s)`);
    serverLog.info(
      `index complete: ${indexState.indexed} indexed, ${indexState.errors} errors`,
    );
  } finally {
    indexState.running = false;
    indexState.finishedAt = new Date().toISOString();
  }
}

let timer: NodeJS.Timeout | null = null;

export function startIndexer(): void {
  if (timer) clearInterval(timer);
  scanMedia().catch((error) => serverLog.error("initial index failed", error));
  if (config.indexIntervalMinutes > 0) {
    timer = setInterval(() => {
      if (!indexState.running)
        scanMedia().catch((error) =>
          serverLog.error("scheduled index failed", error),
        );
    }, config.indexIntervalMinutes * 60_000);
    timer.unref();
  }
}

export function stopIndexer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function databaseInfo(): { files: number; dbPath: string } {
  const row = db.prepare("SELECT COUNT(*) AS count FROM files").get() as {
    count: number;
  };
  return { files: row.count, dbPath: config.dbPath };
}
