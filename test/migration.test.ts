import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifetagger-mig-test-"));
const mediaDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "lifetagger-mig-media-"),
);
process.env.DATA_DIR = dataDir;
process.env.MEDIA_ROOT = mediaDir;
process.env.ALLOWED_MEDIA_ROOTS = mediaDir;

const { db, upsertFile } = await import("../server/db");
const { getMigrationRows, scanMigration } = await import("../server/migration");

function addFile(name: string, description: string, id: number) {
  return upsertFile({
    relativePath: name,
    name,
    folder: "",
    ext: "jpg",
    kind: "image",
    size: 100,
    mtimeMs: id,
    captureAt: null,
    localDate: "2026-01-01",
    gps: null,
    camera: null,
    width: null,
    height: null,
    duration: null,
    description,
    tags: [],
    metadataWritable: true,
    legacyPending: true,
    scanGeneration: 1,
  });
}

test("migration scan rebuilds legacy rows in the background", async () => {
  addFile("photo-[beach].jpg", "A day at the beach", 1);
  addFile("trip.jpg", "beach, sun. A day away", 2);

  const state = await scanMigration();

  assert.equal(state.scanned, true);
  assert.equal(state.pendingFiles, 2);
  assert.equal(state.legacyTags, 2);
  assert.equal(state.needsScan, false);
  assert.equal(state.running, false);

  const rows = getMigrationRows();
  assert.equal(rows.find((row) => row.legacyValue === "beach")?.count, 2);
  assert.equal(rows.find((row) => row.legacyValue === "sun")?.count, 1);
});

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(mediaDir, { recursive: true, force: true });
});
