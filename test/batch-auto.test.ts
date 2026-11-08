import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "lifetagger-batch-test-"),
);
const mediaDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "lifetagger-batch-media-"),
);
process.env.DATA_DIR = dataDir;
process.env.MEDIA_ROOT = mediaDir;
process.env.MEDIA_FOLDER_PATH = "";
process.env.ALLOWED_MEDIA_ROOTS = mediaDir;

const {
  db,
  addTagToFile,
  countAutoOnlyFiles,
  countManuallyTaggedFiles,
  countNeedsReviewFiles,
  fileIsAutoOnly,
  promoteAutoTagsForFile,
  untaggedCandidateRows,
  upsertFile,
} = await import("../server/db");

function addFile(name: string, id: number) {
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
    description: "",
    tags: [],
    metadataWritable: true,
    legacyPending: false,
    scanGeneration: 1,
  });
}

test("auto-only files are review candidates and become manual when promoted", () => {
  const autoId = addFile("auto.jpg", 1);
  const manualId = addFile("manual.jpg", 2);
  const untaggedId = addFile("untagged.jpg", 3);

  addTagToFile(autoId, { key: "people", value: "Alice" }, "face-auto");
  addTagToFile(manualId, { key: "place", value: "Home" }, "user");

  const withAuto = untaggedCandidateRows(10, [], true).map((row) => row.id);
  assert.deepEqual(
    withAuto.sort((a, b) => a - b),
    [autoId, untaggedId],
  );

  const withoutAuto = untaggedCandidateRows(10, [], false).map((row) => row.id);
  assert.deepEqual(withoutAuto, [untaggedId]);

  assert.equal(fileIsAutoOnly(autoId), true);
  assert.equal(fileIsAutoOnly(manualId), false);
  assert.equal(countAutoOnlyFiles(), 1);
  assert.equal(countManuallyTaggedFiles(), 1);
  assert.equal(countNeedsReviewFiles(), 2);

  assert.equal(promoteAutoTagsForFile(autoId), 1);
  assert.equal(fileIsAutoOnly(autoId), false);
  assert.equal(countAutoOnlyFiles(), 0);
  assert.equal(countManuallyTaggedFiles(), 2);
});

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(mediaDir, { recursive: true, force: true });
});
