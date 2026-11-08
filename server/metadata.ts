import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { exiftool } from "exiftool-vendored";
import type { Tag } from "../shared/types";
import {
  dedupeTags,
  formatTag,
  parseLegacyFilename,
  parseTagEntry,
  splitLegacyDescription,
} from "../shared/tag-format";
import { config, serverLog } from "./config";
import { todayKey } from "./db";

export type Metadata = {
  tags: Tag[];
  description: string;
  captureAt: string | null;
  localDate: string | null;
  gps: { lat: number; lon: number } | null;
  camera: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  legacyPending: boolean;
  legacyTags: string[];
};

type ExifDateLike = {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
};

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function validDateParts(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
) {
  if (
    year < 1800 ||
    year > 3000 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  )
    return null;
  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  )
    return null;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return {
    iso: `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`,
    localDate: `${year}-${pad(month)}-${pad(day)}`,
  };
}

function dateOrNull(value: unknown): { iso: string; localDate: string } | null {
  if (!value) return null;
  if (typeof value === "object") {
    const date = value as ExifDateLike;
    if (date.year && date.month && date.day) {
      return validDateParts(
        date.year,
        date.month,
        date.day,
        date.hour ?? 0,
        date.minute ?? 0,
        date.second ?? 0,
      );
    }
  }
  if (typeof value === "string") {
    const match =
      /^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
    if (match) {
      const [, year, month, day, hour, minute, second] = match;
      return validDateParts(
        Number(year),
        Number(month),
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      );
    }
    const dateOnly = /^(\d{4})[:\-](\d{2})[:\-](\d{2})/.exec(value);
    if (dateOnly) {
      const [, year, month, day] = dateOnly;
      return validDateParts(Number(year), Number(month), Number(day));
    }
  }
  return null;
}

function captureDate(
  tags: Record<string, unknown>,
): { iso: string; localDate: string } | null {
  const candidates = [
    tags.DateTimeOriginal,
    tags.CreateDate,
    tags.MediaCreateDate,
    tags.TrackCreateDate,
    tags.FileModifyDate,
  ];
  for (const candidate of candidates) {
    const parsed = dateOrNull(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function gpsFrom(
  tags: Record<string, unknown>,
): { lat: number; lon: number } | null {
  let lat = numberOrNull(tags.GPSLatitude);
  let lon = numberOrNull(tags.GPSLongitude);
  if (lat === null || lon === null) {
    const position = [
      tags.GPSPosition,
      tags.GPSCoordinates,
      tags.GeolocationPosition,
    ].find((value) => value !== undefined && value !== null);
    if (typeof position === "string") {
      const match = /(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/.exec(position);
      if (match) {
        lat = Number(match[1]);
        lon = Number(match[2]);
      }
    } else if (position && typeof position === "object") {
      const coords = position as { latitude?: unknown; longitude?: unknown };
      lat = numberOrNull(coords.latitude);
      lon = numberOrNull(coords.longitude);
    }
  }
  if (lat === null || lon === null) return null;
  if (String(tags.GPSLatitudeRef ?? "").toUpperCase() === "S" && lat > 0)
    lat = -lat;
  if (String(tags.GPSLongitudeRef ?? "").toUpperCase() === "W" && lon > 0)
    lon = -lon;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function fallbackLocalDate(ms: number): string {
  return todayKey(new Date(ms));
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value];
  return [];
}

export function tagsFromMetadata(tags: Record<string, unknown>): Tag[] {
  const subject = stringList(tags.Subject);
  const keywords = stringList(tags.Keywords);
  const entries = subject.length > 0 ? [...subject, ...keywords] : keywords;
  return dedupeTags(
    entries.map(parseTagEntry).filter((tag): tag is Tag => tag !== null),
  );
}

export async function readMetadata(
  absolutePath: string,
  relativePath: string,
): Promise<Metadata> {
  const stat = await fs.promises.stat(absolutePath);
  let tags: Record<string, unknown> = {};
  try {
    tags = (await exiftool.read(absolutePath)) as unknown as Record<
      string,
      unknown
    >;
  } catch (error) {
    serverLog.warn("metadata read failed", relativePath, error);
  }
  const tagsList = tagsFromMetadata(tags);
  const description = String(
    tags.Description ?? tags.ImageDescription ?? "",
  ).trim();
  const date = captureDate(tags);
  const filenameLegacy = parseLegacyFilename(path.basename(absolutePath));
  const descriptionLegacy = splitLegacyDescription(description, {
    allowSingle: Boolean(filenameLegacy),
    filenameTags: filenameLegacy?.tags,
  });
  const legacyTags = dedupeTags(
    [...(filenameLegacy?.tags ?? []), ...descriptionLegacy.tags].map(
      (value) => ({ key: "keyword", value }),
    ),
  ).map((tag) => tag.value);
  return {
    tags: tagsList,
    description,
    captureAt:
      date?.iso ??
      (Number.isFinite(stat.mtimeMs)
        ? new Date(stat.mtimeMs).toISOString()
        : null),
    localDate: date?.localDate ?? fallbackLocalDate(stat.mtimeMs),
    gps: gpsFrom(tags),
    camera: typeof tags.Model === "string" ? tags.Model : null,
    width: numberOrNull(tags.ImageWidth ?? tags.SourceImageWidth),
    height: numberOrNull(tags.ImageHeight ?? tags.SourceImageHeight),
    duration: numberOrNull(tags.Duration) ?? numberOrNull(tags.MediaDuration),
    legacyPending: filenameLegacy !== null || descriptionLegacy.tags.length > 0,
    legacyTags,
  };
}

function backupFolder(relativePath: string): string {
  return path.join(
    config.metadataBackupsDir,
    crypto.createHash("sha1").update(relativePath).digest("hex").slice(0, 16),
  );
}

export async function backupMetadata(
  relativePath: string,
  absolutePath: string,
): Promise<void> {
  try {
    const folder = backupFolder(relativePath);
    await fs.promises.mkdir(folder, { recursive: true });
    const data = await exiftool.read(absolutePath);
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    await fs.promises.writeFile(
      path.join(folder, filename),
      JSON.stringify(data, null, 2),
    );
    const files = (await fs.promises.readdir(folder)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 5))) {
      await fs.promises.unlink(path.join(folder, old)).catch(() => undefined);
    }
  } catch (error) {
    serverLog.warn("metadata backup failed", relativePath, error);
  }
}

export type WriteMetadataInput = {
  relativePath: string;
  absolutePath: string;
  tags: Tag[];
  description: string;
};

export type WriteMetadataResult = {
  metadataWritable: boolean;
  captureAt: string | null;
  localDate: string | null;
};

export async function writeMetadata(
  input: WriteMetadataInput,
): Promise<WriteMetadataResult> {
  const clean = dedupeTags(input.tags);
  const entries = clean.map(formatTag);
  await backupMetadata(input.relativePath, input.absolutePath);
  try {
    await exiftool.write(
      input.absolutePath,
      {
        Subject: entries,
        Description: input.description,
      },
      ["-overwrite_original"],
    );
    const check = (await exiftool.read(
      input.absolutePath,
    )) as unknown as Record<string, unknown>;
    const written = stringList(check.Subject);
    const expected = new Set(entries);
    const actual = new Set(written);
    const matches =
      expected.size === actual.size &&
      [...expected].every((entry) => actual.has(entry));
    if (!matches) throw new Error("metadata verification failed");
    const date = captureDate(check);
    const stat = await fs.promises.stat(input.absolutePath);
    if (fs.existsSync(`${input.absolutePath}_original`)) {
      await fs.promises
        .unlink(`${input.absolutePath}_original`)
        .catch(() => undefined);
    }
    return {
      metadataWritable: true,
      captureAt: date?.iso ?? new Date(stat.mtimeMs).toISOString(),
      localDate: date?.localDate ?? fallbackLocalDate(stat.mtimeMs),
    };
  } catch (error) {
    serverLog.error("metadata write failed", input.relativePath, error);
    return { metadataWritable: false, captureAt: null, localDate: null };
  }
}

export async function closeMetadata(): Promise<void> {
  await exiftool.end();
}
