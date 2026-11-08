import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// app.env is the mounted configuration file; .env is convenient for local development.
dotenv.config({ path: path.join(appRoot, "app.env"), quiet: true });
dotenv.config({ path: path.join(appRoot, ".env"), quiet: true });

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function csv(value: string | undefined, fallback: string[]): string[] {
  if (!value || value.trim() === "") return fallback;
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
}

function pathList(value: string | undefined): string[] {
  if (!value || value.trim() === "") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const dataDir = path.resolve(appRoot, process.env.DATA_DIR || ".lifetagger");
fs.mkdirSync(dataDir, { recursive: true });

const envMediaRoot =
  process.env.MEDIA_ROOT || process.env.MEDIA_FOLDER_PATH || "";

const BASE_IMAGE_EXTENSIONS = [
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "png",
  "gif",
  "webp",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff",
  "bmp",
  "jp2",
  "jxl",
  "psd",
  "dng",
  "cr2",
  "cr3",
  "nef",
  "arw",
  "raf",
  "orf",
  "rw2",
  "pef",
  "srw",
  "x3f",
];

const BASE_VIDEO_EXTENSIONS = [
  "mp4",
  "m4v",
  "mov",
  "avi",
  "mkv",
  "webm",
  "3gp",
  "3g2",
  "mts",
  "m2ts",
  "ts",
  "mpg",
  "mpeg",
  "wmv",
  "asf",
  "flv",
  "f4v",
  "ogv",
  "vob",
  "rm",
  "rmvb",
];

export const IMAGE_EXTENSIONS = new Set([
  ...BASE_IMAGE_EXTENSIONS,
  ...csv(process.env.EXTRA_IMAGE_EXT, []),
]);

export const VIDEO_EXTENSIONS = new Set([
  ...BASE_VIDEO_EXTENSIONS,
  ...csv(process.env.EXTRA_VIDEO_EXT, []),
]);

export const config = {
  appRoot,
  appVersion: "2.0.0",
  port: int(process.env.PORT, 8080),
  host: process.env.HOST || "0.0.0.0",
  dataDir,
  dbPath: path.join(dataDir, "lifetagger.db"),
  thumbsDir: path.join(dataDir, "thumbs"),
  previewsDir: path.join(dataDir, "previews"),
  faceThumbsDir: path.join(dataDir, "face-thumbs"),
  modelsDir: path.join(dataDir, "models"),
  metadataBackupsDir: path.join(dataDir, "metadata-backups"),
  dbSnapshotsDir: path.join(dataDir, "db-snapshots"),
  migrationDir: path.join(dataDir, "migration"),
  envMediaRoot: envMediaRoot ? path.resolve(appRoot, envMediaRoot) : "",
  allowedMediaRoots: pathList(process.env.ALLOWED_MEDIA_ROOTS).map((root) =>
    path.resolve(appRoot, root),
  ),
  excludeExtensions: new Set(
    csv(process.env.EXCLUDE_EXT, [
      "txt",
      "pp3",
      "json",
      "xmp",
      "aae",
      "db",
      "ini",
      "log",
    ]),
  ),
  publicUrl:
    process.env.PUBLIC_URL || `http://localhost:${int(process.env.PORT, 8080)}`,
  timezone:
    process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  dailyGoal: Math.max(1, int(process.env.DAILY_GOAL, 15)),
  suggestionRadiusM: Math.max(50, int(process.env.SUGGEST_RADIUS_M, 200)),
  facesEnabled: bool(process.env.FACE_ENABLED, true),
  faceScanMode:
    process.env.FACE_SCAN_MODE === "background" ? "background" : "on-demand",
  faceModel: process.env.FACE_MODEL || "buffalo_s",
  faceMinConfidence: Number.parseFloat(
    process.env.FACE_MIN_CONFIDENCE || "0.5",
  ),
  faceMatchThreshold: Number.parseFloat(
    process.env.FACE_MATCH_THRESHOLD || "0.55",
  ),
  faceAutoThreshold: Number.parseFloat(
    process.env.FACE_AUTO_THRESHOLD || "0.72",
  ),
  faceAutoMargin: Number.parseFloat(process.env.FACE_AUTO_MARGIN || "0.06"),
  faceMinQuality: Number.parseFloat(process.env.FACE_MIN_QUALITY || "0.55"),
  placeAutoRadiusM: Math.max(1, int(process.env.PLACE_AUTO_RADIUS_M, 50)),
  placeReviewRadiusM: Math.max(50, int(process.env.PLACE_REVIEW_RADIUS_M, 500)),
  previewMaxPx: Math.max(640, int(process.env.PREVIEW_MAX_PX, 2048)),
  thumbPx: Math.max(160, int(process.env.THUMB_PX, 480)),
  indexIntervalMinutes: Math.max(0, int(process.env.INDEX_INTERVAL_MIN, 30)),
  indexConcurrency: Math.max(
    1,
    Math.min(16, int(process.env.INDEX_CONCURRENCY, 4)),
  ),
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
  vapidSubject: process.env.VAPID_SUBJECT || "mailto:lifetagger@localhost",
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  logLevel: process.env.LOG_LEVEL || "info",
};

for (const dir of [
  config.thumbsDir,
  config.previewsDir,
  config.faceThumbsDir,
  config.modelsDir,
  config.metadataBackupsDir,
  config.dbSnapshotsDir,
  config.migrationDir,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

export function isMediaExtension(ext: string): boolean {
  const clean = ext.toLowerCase().replace(/^\./, "");
  if (config.excludeExtensions.has(clean)) return false;
  return IMAGE_EXTENSIONS.has(clean) || VIDEO_EXTENSIONS.has(clean);
}

export function mediaKind(ext: string): "image" | "video" {
  return VIDEO_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ""))
    ? "video"
    : "image";
}

export function isWithinAllowedRoots(candidate: string): boolean {
  let resolved = path.resolve(candidate);
  try {
    resolved = fs.realpathSync(resolved);
  } catch {
    // The caller will report a missing path separately.
  }
  if (config.allowedMediaRoots.length === 0) return true;
  return config.allowedMediaRoots.some((root) => {
    let realRoot = path.resolve(root);
    try {
      realRoot = fs.realpathSync(realRoot);
    } catch {
      // Keep the lexical root when it does not exist yet.
    }
    return (
      resolved === realRoot || resolved.startsWith(`${realRoot}${path.sep}`)
    );
  });
}

export const serverLog = {
  info: (...args: unknown[]) => {
    if (config.logLevel !== "silent") console.log("[lifetagger]", ...args);
  },
  warn: (...args: unknown[]) => console.warn("[lifetagger]", ...args),
  error: (...args: unknown[]) => console.error("[lifetagger]", ...args),
};
