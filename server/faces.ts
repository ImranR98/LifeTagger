import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { hasLegacyTags, valueNorm } from "../shared/tag-format";
import type { Face } from "../shared/types";
import { config, serverLog } from "./config";
import {
  type FaceRow,
  type FileRow,
  addTagToFile,
  db,
  faceForId,
  facesForFile,
  fileRowById,
  getSetting,
  labeledFaces,
  markFacesFailed,
  referenceFaces,
  removeTagFromFileIfSource,
  replaceFacesForFile,
  setFaceLabel,
  tagsForFile,
  unknownFaces,
  updateFileAfterWrite,
} from "./db";
import { absolutePathFor, getPreview } from "./media";
import { writeMetadata } from "./metadata";
import { beginTask, finishTask, isTaskRunning, updateTask } from "./tasks";

type HumanFace = {
  box: [number, number, number, number];
  score: number;
  embedding?: number[];
};

type HumanLike = {
  load: () => Promise<void>;
  detect: (input: unknown) => Promise<{ face: HumanFace[] }>;
  tf: {
    tensor3d: (data: Uint8Array, shape: number[]) => { dispose: () => void };
  };
};

let humanPromise: Promise<HumanLike | null> | null = null;
let faceQueueRunning = false;
const faceQueue: FileRow[] = [];
let knownFaceCache: {
  at: number;
  rows: (FaceRow & { file_path: string })[];
} | null = null;

function knownFaces(): (FaceRow & { file_path: string })[] {
  if (!knownFaceCache || Date.now() - knownFaceCache.at > 30_000) {
    knownFaceCache = { at: Date.now(), rows: referenceFaces() };
  }
  return knownFaceCache.rows;
}

function invalidateKnownFaces(): void {
  knownFaceCache = null;
}

function installNodeShims(): void {
  // tfjs-node still calls util.isNullOrUndefined, removed in recent Node versions.
  if (
    typeof (util as unknown as { isNullOrUndefined?: unknown })
      .isNullOrUndefined !== "function"
  ) {
    (
      util as unknown as { isNullOrUndefined: (value: unknown) => boolean }
    ).isNullOrUndefined = (value) => value === null || value === undefined;
  }
  const globalWithFetch = globalThis as typeof globalThis & {
    fetch: typeof fetch;
  };
  if (
    !(globalWithFetch as unknown as { __lifetaggerPatched?: boolean })
      .__lifetaggerPatched
  ) {
    const originalFetch = globalWithFetch.fetch;
    globalWithFetch.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (
        typeof url === "string" &&
        (url.startsWith("file://") || path.isAbsolute(url))
      ) {
        const filename = url.startsWith("file://") ? fileURLToPath(url) : url;
        const data = await fs.promises.readFile(filename);
        return new Response(data, { status: 200 });
      }
      return originalFetch(input, init);
    };
    (
      globalWithFetch as unknown as { __lifetaggerPatched?: boolean }
    ).__lifetaggerPatched = true;
  }
}

export function facesAvailable(): boolean {
  if (getSetting("facesEnabled") === "false") return false;
  return fs.existsSync(
    path.join(config.appRoot, "node_modules/@vladmandic/human/models"),
  );
}

async function getHuman(): Promise<HumanLike | null> {
  if (!facesAvailable()) return null;
  if (!humanPromise) {
    humanPromise = (async () => {
      installNodeShims();
      const module = (await import("@vladmandic/human")) as unknown as {
        Human: new (config: Record<string, unknown>) => HumanLike;
      };
      const modelBasePath =
        path.join(config.appRoot, "node_modules/@vladmandic/human/models") +
        path.sep;
      const human = new module.Human({
        backend: "tensorflow",
        modelBasePath,
        debug: false,
        cacheModels: true,
        face: {
          enabled: true,
          detector: {
            maxDetected: 10,
            minConfidence: config.faceMinConfidence,
          },
          mesh: { enabled: false },
          iris: { enabled: false },
          emotion: { enabled: false },
          description: { enabled: true },
          antispoof: { enabled: false },
          liveness: { enabled: false },
        },
        body: { enabled: false },
        hand: { enabled: false },
        object: { enabled: false },
        gesture: { enabled: false },
      });
      await human.load();
      serverLog.info("face models loaded");
      return human;
    })().catch((error) => {
      serverLog.error("face model load failed", error);
      return null;
    });
  }
  return humanPromise;
}

export function embeddingToArray(buffer: Uint8Array): number[] {
  const view = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  return Array.from(view);
}

export async function processFacesForFile(
  file: FileRow,
  options: { force?: boolean } = {},
): Promise<void> {
  if (!facesAvailable()) return;
  if (!options.force && isTaskRunning()) return;
  if (file.faces_processed !== 0) return;
  const human = await getHuman();
  if (!human) {
    markFacesFailed(file.id);
    return;
  }
  try {
    const preview = await getPreview(file);
    const { data, info } = await sharp(preview)
      .rotate()
      .resize({
        width: 1280,
        height: 1280,
        fit: "inside",
        withoutEnlargement: true,
      })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tensor = human.tf.tensor3d(new Uint8Array(data), [
      info.height,
      info.width,
      3,
    ]);
    let result: { face: HumanFace[] };
    try {
      result = await human.detect(tensor);
    } finally {
      tensor.dispose();
    }
    const faces = result.face
      .filter(
        (face) =>
          face.embedding &&
          face.embedding.length > 0 &&
          face.score >= config.faceMinConfidence,
      )
      .map((face) => ({
        bbox: {
          x: Math.max(0, face.box[0] / info.width),
          y: Math.max(0, face.box[1] / info.height),
          w: Math.min(1, face.box[2] / info.width),
          h: Math.min(1, face.box[3] / info.height),
        },
        embedding: face.embedding as number[],
        quality: face.score,
      }));
    replaceFacesForFile(file.id, faces);
    const people = tagsForFile(file.id).filter((tag) => tag.key === "people");
    if (faces.length === 1 && people.length === 1) {
      const stored = facesForFile(file.id)[0];
      if (stored)
        setFaceLabel(stored.id, people[0]!.value, {
          source: "tag-sync",
          confidence: 1,
        });
    }
    invalidateKnownFaces();
    serverLog.info("faces processed", file.path, faces.length);
  } catch (error) {
    markFacesFailed(file.id);
    serverLog.warn("face processing failed", file.path, error);
  }
}

export function queueFaceProcessing(file: FileRow): void {
  if (!facesAvailable() || file.faces_processed !== 0) return;
  if (faceQueue.some((entry) => entry.id === file.id)) return;
  faceQueue.push(file);
  void runFaceQueue();
}

async function runFaceQueue(): Promise<void> {
  if (faceQueueRunning) return;
  faceQueueRunning = true;
  try {
    while (faceQueue.length > 0) {
      const file = faceQueue.shift();
      if (!file) continue;
      const fresh = fileRowById(file.id);
      if (!fresh) continue;
      await processFacesForFile(fresh);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    faceQueueRunning = false;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function faceSuggestionsForFile(
  fileId: number,
): { person: string; confidence: number }[] {
  if (!facesAvailable()) return [];
  const own = facesForFile(fileId);
  if (own.length === 0) return [];
  const known = knownFaces().filter(
    (face) => face.file_id !== fileId && face.label,
  );
  if (known.length === 0) return [];
  const best = new Map<string, number>();
  for (const face of own) {
    const embedding = embeddingToArray(face.embedding);
    for (const candidate of known) {
      const similarity = cosine(
        embedding,
        embeddingToArray(candidate.embedding),
      );
      if (similarity < config.faceMatchThreshold || !candidate.label) continue;
      if (similarity > (best.get(candidate.label) ?? 0))
        best.set(candidate.label, similarity);
    }
  }
  return Array.from(best.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([person, confidence]) => ({
      person,
      confidence: Math.min(0.98, confidence),
    }));
}

/**
 * If a file has exactly one detected face and exactly one people tag, the
 * mapping is unambiguous. Label the face so it becomes a known face for
 * future suggestions. This also covers tags added after face detection.
 */
export function syncFaceLabelForFile(fileId: number): boolean {
  if (isTaskRunning()) return false;
  const faces = facesForFile(fileId);
  if (faces.length !== 1) return false;
  const face = faces[0]!;
  if (face.person_tag_id !== null) return false;
  const people = tagsForFile(fileId).filter((tag) => tag.key === "people");
  if (people.length !== 1) return false;
  setFaceLabel(face.id, people[0]!.value, {
    source: "tag-sync",
    confidence: 1,
  });
  invalidateKnownFaces();
  return true;
}

/** Backfill unambiguous face labels from people tags after indexing. */
export function labelUnambiguousPeopleFaces(limit = 1000): number {
  if (!facesAvailable()) return 0;
  const rows = db
    .prepare(
      `SELECT f.id AS face_id, t.value AS person
       FROM faces f
       JOIN file_tags ft ON ft.file_id = f.file_id
       JOIN tags t ON t.id = ft.tag_id AND t.key = 'people'
       WHERE f.person_tag_id IS NULL
         AND (SELECT COUNT(*) FROM faces f2 WHERE f2.file_id = f.file_id) = 1
         AND (SELECT COUNT(*) FROM file_tags ft2
              JOIN tags t2 ON t2.id = ft2.tag_id
              WHERE ft2.file_id = f.file_id AND t2.key = 'people') = 1
       LIMIT ?`,
    )
    .all(limit) as { face_id: number; person: string }[];
  for (const row of rows)
    setFaceLabel(row.face_id, row.person, {
      source: "tag-sync",
      confidence: 1,
    });
  if (rows.length > 0) invalidateKnownFaces();
  return rows.length;
}

export function faceListForFile(fileId: number): Face[] {
  return facesForFile(fileId).map((face) => ({
    id: face.id,
    fileId: face.file_id,
    bbox: JSON.parse(face.bbox) as {
      x: number;
      y: number;
      w: number;
      h: number;
    },
    label: face.label,
    labelSource: face.label_source,
    labelConfidence: face.label_confidence,
    confidence: face.quality,
  }));
}

export async function labelFace(
  faceId: number,
  person: string | null,
): Promise<{ fileId: number } | null> {
  if (isTaskRunning())
    throw new Error("Wait for the current task to finish before labeling");
  const previous = faceForId(faceId)?.label ?? null;
  const result = setFaceLabel(faceId, person);
  if (!result) return null;
  if (person) {
    addTagToFile(result.fileId, { key: "people", value: person }, "face");
  }
  if (previous && (!person || valueNorm(previous) !== valueNorm(person))) {
    const stillUsed = facesForFile(result.fileId).some(
      (face) => face.id !== faceId && face.label === previous,
    );
    if (!stillUsed) {
      for (const source of ["face", "face-auto"]) {
        removeTagFromFileIfSource(
          result.fileId,
          { key: "people", value: previous },
          source,
        );
      }
    }
  }
  if (person || previous) await persistFileTags(result.fileId);
  invalidateKnownFaces();
  return { fileId: result.fileId };
}

async function persistFileTags(fileId: number): Promise<boolean> {
  const row = fileRowById(fileId);
  if (!row) return false;
  const absolute = absolutePathFor(row);
  if (!absolute) return false;
  const tags = tagsForFile(fileId);
  try {
    const written = await writeMetadata({
      relativePath: row.path,
      absolutePath: absolute,
      tags,
      description: row.description ?? "",
    });
    const stat = await fs.promises.stat(absolute);
    updateFileAfterWrite(fileId, {
      description: row.description ?? "",
      tags,
      metadataWritable: written.metadataWritable,
      mtimeMs: Math.floor(stat.mtimeMs),
      size: stat.size,
      captureAt: written.captureAt ?? row.capture_at,
      localDate: written.localDate ?? row.local_date,
      legacyPending: hasLegacyTags(row.name, row.description ?? ""),
    });
    return true;
  } catch (error) {
    serverLog.warn("face tag metadata write failed", row.path, error);
    return false;
  }
}

async function persistLabeledFiles(
  fileIds: number[],
  label: string,
): Promise<void> {
  let errors = 0;
  for (let index = 0; index < fileIds.length; index++) {
    const ok = await persistFileTags(fileIds[index]!);
    if (!ok) errors++;
    updateTask({ processed: index + 1, errors });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  finishTask(
    errors,
    `${label}: ${fileIds.length} file${fileIds.length === 1 ? "" : "s"}, ${errors} error${errors === 1 ? "" : "s"}`,
  );
}

export function peopleList(): {
  name: string;
  count: number;
  faceId: number;
  fileId: number;
}[] {
  const groups = new Map<
    string,
    {
      name: string;
      count: number;
      faceId: number;
      fileId: number;
      quality: number;
    }
  >();
  for (const face of labeledFaces()) {
    if (!face.label) continue;
    const current = groups.get(face.label);
    if (!current)
      groups.set(face.label, {
        name: face.label,
        count: 1,
        faceId: face.id,
        fileId: face.file_id,
        quality: face.quality,
      });
    else {
      current.count++;
      if (face.quality > current.quality) {
        current.faceId = face.id;
        current.fileId = face.file_id;
        current.quality = face.quality;
      }
    }
  }
  return Array.from(groups.values())
    .sort((a, b) => b.count - a.count)
    .map(({ quality, ...rest }) => rest);
}

export type FaceCluster = {
  id: number;
  faces: { faceId: number; fileId: number; path: string; name: string }[];
  faceIds: number[];
  representativeFaceId: number | null;
  representativeFileId: number | null;
  size: number;
};

export function unknownFaceClusters(): FaceCluster[] {
  const unknown = unknownFaces();
  const clusters: { embeddings: number[][]; faces: FaceRow[] }[] = [];
  for (const face of unknown) {
    const embedding = embeddingToArray(face.embedding);
    let target = clusters.find((cluster) =>
      cluster.embeddings.some(
        (candidate) =>
          cosine(embedding, candidate) >= config.faceMatchThreshold,
      ),
    );
    if (!target) {
      target = { embeddings: [], faces: [] };
      clusters.push(target);
    }
    target.embeddings.push(embedding);
    target.faces.push(face);
  }
  return clusters
    .filter((cluster) => cluster.faces.length >= 2)
    .sort((a, b) => b.faces.length - a.faces.length)
    .slice(0, 30)
    .map((cluster, index) => ({
      id: index,
      faces: cluster.faces.slice(0, 12).map((face) => ({
        faceId: face.id,
        fileId: face.file_id,
        path: (face as FaceRow & { file_path?: string }).file_path ?? "",
        name: (face as FaceRow & { name?: string }).name ?? "",
      })),
      faceIds: cluster.faces.map((face) => face.id),
      representativeFaceId: cluster.faces[0]?.id ?? null,
      representativeFileId: cluster.faces[0]?.file_id ?? null,
      size: cluster.faces.length,
    }));
}

export type LabelClusterResult = {
  started: boolean;
  updated: number;
  reason?: string;
};

export async function labelCluster(
  faceIds: number[],
  person: string,
): Promise<LabelClusterResult> {
  if (isTaskRunning()) {
    return {
      started: false,
      updated: 0,
      reason: "Wait for the current task to finish",
    };
  }
  if (!beginTask("cluster-label", 0, `Naming faces as ${person}`)) {
    return {
      started: false,
      updated: 0,
      reason: "Wait for the current task to finish",
    };
  }
  let updated = 0;
  const touched = new Set<number>();
  try {
    for (const faceId of faceIds) {
      const face = faceForId(faceId);
      if (!face) continue;
      setFaceLabel(faceId, person);
      addTagToFile(face.file_id, { key: "people", value: person }, "face");
      touched.add(face.file_id);
      updated++;
    }
  } catch (error) {
    finishTask(
      1,
      `Naming failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
  invalidateKnownFaces();
  if (touched.size === 0) {
    finishTask(0, "No matching faces were labeled");
  } else {
    updateTask({ total: touched.size, processed: 0 });
    void persistLabeledFiles(
      Array.from(touched),
      `Named ${updated} face${updated === 1 ? "" : "s"}`,
    );
  }
  return { started: true, updated };
}
