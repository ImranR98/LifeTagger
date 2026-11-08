import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { exiftool } from "exiftool-vendored";
import { config, serverLog } from "./config";
import type { FileRow } from "./db";
import { getMediaRoot } from "./db";

const execFileAsync = promisify(execFile);
const running = new Map<string, Promise<string>>();

export function absolutePathFor(row: Pick<FileRow, "path">): string | null {
  const root = getMediaRoot();
  if (!root) return null;
  const resolved = path.resolve(root, row.path);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    return null;
  try {
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(resolved);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`))
      return null;
    return realFile;
  } catch {
    return resolved;
  }
}

function thumbPath(row: Pick<FileRow, "id">): string {
  return path.join(config.thumbsDir, `${row.id}.jpg`);
}

function previewPath(row: Pick<FileRow, "id">): string {
  return path.join(config.previewsDir, `${row.id}.jpg`);
}

async function imageToJpeg(
  input: string,
  output: string,
  maxPx: number,
  fallbackPreview = false,
): Promise<void> {
  try {
    await sharp(input, { failOn: "none", limitInputPixels: 268_402_689 })
      .rotate()
      .resize({
        width: maxPx,
        height: maxPx,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: maxPx > 1000 ? 86 : 76, progressive: true })
      .toFile(output);
    return;
  } catch (error) {
    if (!fallbackPreview) throw error;
  }
  const tmp = `${output}.preview`;
  await exiftool.extractPreview(input, tmp).catch(async () => {
    await exiftool.extractJpgFromRaw(input, tmp);
  });
  try {
    await sharp(tmp, { failOn: "none" })
      .rotate()
      .resize({
        width: maxPx,
        height: maxPx,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 84, progressive: true })
      .toFile(output);
  } finally {
    await fs.promises.unlink(tmp).catch(() => undefined);
  }
}

async function ffmpegPoster(
  input: string,
  output: string,
  maxPx: number,
  seek: string,
): Promise<void> {
  await execFileAsync(
    config.ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      seek,
      "-i",
      input,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${maxPx},iw)':-2`,
      "-q:v",
      "3",
      "-y",
      output,
    ],
    { timeout: 45_000 },
  );
}

async function videoPoster(
  input: string,
  output: string,
  maxPx: number,
): Promise<void> {
  try {
    await ffmpegPoster(input, output, maxPx, "1");
  } catch {
    await ffmpegPoster(input, output, maxPx, "0");
  }
  if (!fs.existsSync(output))
    throw new Error("ffmpeg did not produce a poster");
}

async function ensureImage(
  row: FileRow,
  target: string,
  maxPx: number,
): Promise<string> {
  if (fs.existsSync(target) && (await fs.promises.stat(target)).size > 0)
    return target;
  const existing = running.get(target);
  if (existing) return existing;
  const promise = (async () => {
    const input = absolutePathFor(row);
    if (!input) throw new Error("media root is not configured");
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    if (row.kind === "video") await videoPoster(input, target, maxPx);
    else await imageToJpeg(input, target, maxPx, true);
    return target;
  })().finally(() => running.delete(target));
  running.set(target, promise);
  return promise;
}

export async function getThumbnail(row: FileRow): Promise<string> {
  return ensureImage(row, thumbPath(row), config.thumbPx);
}

export async function getPreview(row: FileRow): Promise<string> {
  return ensureImage(row, previewPath(row), config.previewMaxPx);
}

export async function generateBatchAssets(rows: FileRow[]): Promise<void> {
  for (const row of rows) {
    try {
      await getThumbnail(row);
      if (row.kind === "image") await getPreview(row);
    } catch (error) {
      serverLog.warn("asset generation failed", row.path, error);
    }
  }
}

export async function cleanAssetCaches(fileId: number): Promise<void> {
  await Promise.all(
    [config.thumbsDir, config.previewsDir].map((folder) =>
      fs.promises
        .unlink(path.join(folder, `${fileId}.jpg`))
        .catch(() => undefined),
    ),
  );
}
