import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "lifetagger-pagination-test-"),
);
process.env.DATA_DIR = dataDir;
process.env.MEDIA_ROOT = "";
process.env.MEDIA_FOLDER_PATH = "";
process.env.ALLOWED_MEDIA_ROOTS = "";

const { db, fileListCursor, listFileRows, upsertFile } =
  await import("../server/db");

function addFile(name: string, id: number, captureAt: string): number {
  return upsertFile({
    relativePath: name,
    name,
    folder: "",
    ext: "jpg",
    kind: "image",
    size: 100,
    mtimeMs: id,
    captureAt,
    localDate: captureAt.slice(0, 10),
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

for (let index = 0; index < 6; index++) {
  addFile(`photo-${index}.jpg`, index + 1, `2026-01-0${index + 1}T10:00:00`);
}

function collect(sort: "oldest" | "name"): number[] {
  const ids: number[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const rows = listFileRows({ sort, cursor, limit: 2 });
    ids.push(...rows.map((row) => row.id));
    const last = rows.at(-1);
    if (!last) break;
    const next = fileListCursor(last, sort);
    if (next === cursor) break;
    cursor = next;
    if (rows.length < 2) break;
  }
  return ids;
}

test("ascending library sorts paginate without gaps or duplicates", () => {
  for (const sort of ["oldest", "name"] as const) {
    const ids = collect(sort);
    assert.deepEqual(new Set(ids).size, ids.length);
    assert.equal(ids.length, 6);
  }
});

after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
