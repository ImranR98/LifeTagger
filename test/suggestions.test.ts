import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "lifetagger-suggestions-test-"),
);
process.env.DATA_DIR = dataDir;
process.env.MEDIA_ROOT = "";
process.env.MEDIA_FOLDER_PATH = "";
process.env.ALLOWED_MEDIA_ROOTS = "";

const {
  addTagToFile,
  currentTagMutationVersion,
  db,
  recentTagCounts,
  upsertFile,
} = await import("../server/db");
const { rankSuggestions } = await import("../server/suggestions");

function addFile(name: string, id: number): number {
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

test("a recently used tag can displace an older capped suggestion", () => {
  const old = Array.from({ length: 5 }, (_, index) => ({
    key: "people",
    value: `Old ${index}`,
    score: 0.9 - index * 0.01,
    support: 1,
    evidence: new Set<number>(),
    source: "same-day" as const,
  }));
  const recent = {
    key: "people",
    value: "New",
    score: 0.5,
    support: 1,
    evidence: new Set<number>(),
    source: "recent" as const,
    lastUsed: new Date().toISOString(),
  };
  const ranked = rankSuggestions([...old, recent]);
  assert.equal(ranked.length, 5);
  assert.ok(ranked.some((suggestion) => suggestion.value === "New"));
});

test("recent tag counts expose last-used and ignore auto tags", () => {
  const fileId = addFile("one.jpg", 1);
  addTagToFile(fileId, { key: "people", value: "Alice" }, "user");
  addTagToFile(fileId, { key: "people", value: "Auto" }, "face-auto");
  const before = currentTagMutationVersion();
  addTagToFile(fileId, { key: "place", value: "Home" }, "user");
  assert.notEqual(currentTagMutationVersion(), before);
  const rows = recentTagCounts(30, 20);
  assert.ok(rows.some((row) => row.value === "Alice" && row.lastUsed));
  assert.ok(!rows.some((row) => row.value === "Auto"));
});

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
