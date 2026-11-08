import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifetagger-db-test-"));
process.env.DATA_DIR = dataDir;
process.env.MEDIA_ROOT = "";
process.env.MEDIA_FOLDER_PATH = "";
process.env.ALLOWED_MEDIA_ROOTS = "";

const { db, facesForFile, replaceFacesForFile, tagsForFile, upsertFile } =
  await import("../server/db");
const { renameTagValue } = await import("../server/tags");
const { labelFace } = await import("../server/faces");

test("a case-only tag rename preserves every file association", async () => {
  const fileId = upsertFile({
    relativePath: "test/photo.jpg",
    name: "photo.jpg",
    folder: "test",
    ext: "jpg",
    kind: "image",
    size: 100,
    mtimeMs: 1,
    captureAt: null,
    localDate: "2026-01-01",
    gps: null,
    camera: null,
    width: null,
    height: null,
    duration: null,
    description: "",
    tags: [{ key: "people", value: "John R" }],
    metadataWritable: true,
    legacyPending: false,
    scanGeneration: 1,
  });

  assert.deepEqual(
    tagsForFile(fileId).map((tag) => ({ ...tag })),
    [{ key: "people", value: "John R" }],
  );

  const result = await renameTagValue("people", "John R", "john r");

  assert.equal(result.started, true);
  assert.equal(result.updated, 1);
  assert.deepEqual(
    tagsForFile(fileId).map((tag) => ({ ...tag })),
    [{ key: "people", value: "john r" }],
  );

  replaceFacesForFile(fileId, [
    {
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      embedding: new Array(512).fill(0.1),
      quality: 0.9,
    },
  ]);
  const faceId = facesForFile(fileId)[0]!.id;
  await labelFace(faceId, "Alice");
  assert.deepEqual(
    tagsForFile(fileId).map((tag) => ({ ...tag })),
    [
      { key: "people", value: "Alice" },
      { key: "people", value: "john r" },
    ],
  );
  await labelFace(faceId, "alice");
  assert.deepEqual(
    tagsForFile(fileId).map((tag) => ({ ...tag })),
    [
      { key: "people", value: "Alice" },
      { key: "people", value: "john r" },
    ],
  );
  await labelFace(faceId, null);
  assert.deepEqual(
    tagsForFile(fileId).map((tag) => ({ ...tag })),
    [{ key: "people", value: "john r" }],
  );
});

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
