import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifetagger-auto-test-"));
const mediaDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "lifetagger-auto-media-"),
);
process.env.DATA_DIR = dataDir;
process.env.MEDIA_ROOT = mediaDir;
process.env.MEDIA_FOLDER_PATH = "";
process.env.ALLOWED_MEDIA_ROOTS = mediaDir;

const {
  db,
  facesForFile,
  replaceFacesForFile,
  setFaceLabel,
  tagsForFile,
  upsertFile,
} = await import("../server/db");
const { startFaceAutomation, startPlaceAutomation } =
  await import("../server/automation");
const { getTask } = await import("../server/tasks");

function addFile(input: {
  name: string;
  id: number;
  tags?: { key: string; value: string }[];
  gps?: { lat: number; lon: number } | null;
}) {
  return upsertFile({
    relativePath: input.name,
    name: input.name,
    folder: "",
    ext: "jpg",
    kind: "image",
    size: 100,
    mtimeMs: input.id,
    captureAt: null,
    localDate: "2026-01-01",
    gps: input.gps ?? null,
    camera: null,
    width: null,
    height: null,
    duration: null,
    description: "",
    tags: input.tags ?? [],
    metadataWritable: true,
    legacyPending: false,
    scanGeneration: 1,
  });
}

async function waitForTask() {
  for (let i = 0; i < 200; i++) {
    if (!getTask()?.running) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("task did not finish");
}

test("place automation auto-tags a very close known place", async () => {
  addFile({
    name: "known.jpg",
    id: 1,
    gps: { lat: 43.65, lon: -79.38 },
    tags: [{ key: "place", value: "Home" }],
  });
  const targetId = addFile({
    name: "target.jpg",
    id: 2,
    gps: { lat: 43.6503, lon: -79.38 },
  });

  const started = startPlaceAutomation();
  assert.equal(started.started, true);
  await waitForTask();

  const tags = tagsForFile(targetId).map((tag) => ({ ...tag }));
  assert.deepEqual(tags, [
    { key: "place", value: "Home", source: "place-auto" },
  ]);
});

test("face automation auto-labels a known face", async () => {
  const referenceFile = addFile({
    name: "reference.jpg",
    id: 3,
    tags: [{ key: "people", value: "Alice" }],
  });
  replaceFacesForFile(referenceFile, [
    {
      bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      embedding: new Array(512).fill(0.2),
      quality: 0.95,
    },
  ]);
  const referenceFace = facesForFile(referenceFile)[0]!;
  setFaceLabel(referenceFace.id, "Alice", {
    source: "manual",
    confidence: 1,
  });

  const targetId = addFile({ name: "face-target.jpg", id: 4 });
  replaceFacesForFile(targetId, [
    {
      bbox: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 },
      embedding: new Array(512).fill(0.2),
      quality: 0.95,
    },
  ]);

  const started = startFaceAutomation();
  assert.equal(started.started, true);
  await waitForTask();

  assert.notEqual(facesForFile(targetId)[0]!.person_tag_id, null);
  assert.deepEqual(
    tagsForFile(targetId).map((tag) => ({ ...tag })),
    [{ key: "people", value: "Alice", source: "face-auto" }],
  );
});

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(mediaDir, { recursive: true, force: true });
});
