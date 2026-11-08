import type { Tag } from "../shared/types";
import type { FileRow } from "./db";
import {
  filesSharingTags,
  getSetting,
  globalTagCounts,
  nearbyFileRows,
  recentTagCounts,
  rejectedSuggestions,
  sameDayFileRows,
  sameFolderFileRows,
  sequenceFileRows,
  tagRowsForFiles,
  tagsForFile,
} from "./db";
import { config } from "./config";
import { dedupeTags, valueNorm } from "../shared/tag-format";
import { faceSuggestionsForFile } from "./faces";

type Source =
  | "same-day"
  | "same-folder"
  | "gps"
  | "sequence"
  | "co-occurrence"
  | "recent"
  | "face";

type Aggregate = {
  key: string;
  value: string;
  score: number;
  support: number;
  evidence: Set<number>;
  source: Source;
  distance?: number;
};

export type Neighbor = {
  row: FileRow;
  weight: number;
  source: Source;
  distance?: number;
};

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
}

function hoursApart(a: FileRow, b: FileRow): number | null {
  const left = parseTime(a.capture_at);
  const right = parseTime(b.capture_at);
  if (left === null || right === null) return null;
  return Math.abs(left - right) / 3_600_000;
}

export function buildNeighbors(file: FileRow): Neighbor[] {
  const neighbors = new Map<number, Neighbor>();
  const radius = Number(
    getSetting("suggestionRadiusM") ?? config.suggestionRadiusM,
  );
  const add = (
    row: FileRow,
    weight: number,
    source: Source,
    distance?: number,
  ) => {
    if (row.id === file.id) return;
    const current = neighbors.get(row.id);
    if (!current || weight > current.weight)
      neighbors.set(row.id, { row, weight, source, distance });
  };

  for (const row of sameDayFileRows(file)) {
    let weight = 0.55;
    const apart = hoursApart(file, row);
    if (apart !== null && apart <= 2) weight += 0.15;
    add(row, weight, "same-day");
  }
  for (const row of sameFolderFileRows(file)) {
    add(row, 0.45, "same-folder");
  }
  for (const row of nearbyFileRows(file, Math.max(radius * 5, 2000))) {
    if (
      file.gps_lat === null ||
      file.gps_lon === null ||
      row.gps_lat === null ||
      row.gps_lon === null
    )
      continue;
    const distance = haversineMeters(
      file.gps_lat,
      file.gps_lon,
      row.gps_lat,
      row.gps_lon,
    );
    if (distance > Math.max(radius * 5, 2000)) continue;
    const weight =
      distance <= radius / 2
        ? 0.98
        : distance <= radius
          ? 0.88
          : distance <= radius * 5
            ? 0.68
            : 0.5;
    add(row, weight, "gps", distance);
  }
  for (const row of sequenceFileRows(file)) {
    add(row, 0.68, "sequence");
  }
  for (const row of filesSharingTags(file, tagsForFile(file.id))) {
    add(row, 0.36, "co-occurrence");
  }
  return Array.from(neighbors.values());
}

function keyWeight(key: string, source: Source): number {
  if (key === "place") {
    if (source === "gps") return 1;
    if (source === "same-folder") return 0.75;
    if (source === "same-day") return 0.55;
    return 0.3;
  }
  if (key === "event") {
    if (source === "same-day") return 1;
    if (source === "same-folder") return 0.9;
    if (source === "gps") return 0.8;
    if (source === "co-occurrence") return 0.5;
    return 0.4;
  }
  if (key === "people") {
    if (source === "same-day") return 1;
    if (source === "sequence") return 0.9;
    if (source === "same-folder") return 0.75;
    if (source === "gps") return 0.7;
    if (source === "co-occurrence") return 0.55;
    return 0.4;
  }
  if (key === "mood") {
    if (source === "co-occurrence") return 0.75;
    if (source === "same-day") return 0.55;
    return 0.35;
  }
  if (source === "face") return 1;
  if (source === "recent") return 0.45;
  return 0.6;
}

function sourceReason(
  source: Source,
  key: string,
  value: string,
  support: number,
  distance?: number,
): string {
  const suffix = support > 1 ? ` (${support} photos)` : "";
  switch (source) {
    case "same-day":
      return `Same day as tagged photos${suffix}`;
    case "same-folder":
      return `Same folder as tagged photos${suffix}`;
    case "gps": {
      if (distance !== undefined && distance < 1000) {
        return `Taken ${Math.max(10, Math.round(distance / 10) * 10)} m from a photo tagged ${key}=${value}`;
      }
      return `Taken nearby tagged photos${suffix}`;
    }
    case "sequence":
      return "Adjacent shot in this series";
    case "co-occurrence":
      return `Usually tagged with your other tags${suffix}`;
    case "recent":
      return "Recently used";
    case "face":
      return `Face matches ${value}`;
    default:
      return "Suggested from your library";
  }
}

function capFor(key: string): number {
  if (key === "people") return 5;
  if (key === "place" || key === "event") return 2;
  if (key === "mood") return 3;
  return 3;
}

let priorCache: {
  at: number;
  rows: { key: string; value: string; count: number }[];
} | null = null;

function priorRows(): { key: string; value: string; count: number }[] {
  if (!priorCache || Date.now() - priorCache.at > 30_000) {
    priorCache = {
      at: Date.now(),
      rows: [...recentTagCounts(30, 30), ...globalTagCounts(30)],
    };
  }
  return priorCache.rows;
}

export function clearSuggestionCache(): void {
  priorCache = null;
}

export function suggestionsForFile(
  file: FileRow,
  date?: string,
): ReturnType<typeof rankSuggestions> {
  const current = new Set(
    tagsForFile(file.id).map(
      (tag) => `${tag.key}\u0000${valueNorm(tag.value)}`,
    ),
  );
  const rejected = date
    ? rejectedSuggestions(date, file.id)
    : new Set<string>();
  const neighbors = buildNeighbors(file);
  const tagMap = tagRowsForFiles(neighbors.map((neighbor) => neighbor.row.id));
  const aggregates = new Map<string, Aggregate>();

  for (const neighbor of neighbors) {
    const tags = tagMap.get(neighbor.row.id) ?? [];
    for (const tag of tags) {
      const id = `${tag.key}\u0000${valueNorm(tag.value)}`;
      if (current.has(id) || rejected.has(id)) continue;
      const weighted = neighbor.weight * keyWeight(tag.key, neighbor.source);
      const existing = aggregates.get(id);
      if (!existing) {
        aggregates.set(id, {
          key: tag.key,
          value: tag.value,
          score: weighted,
          support: 1,
          evidence: new Set([neighbor.row.id]),
          source: neighbor.source,
          distance: neighbor.distance,
        });
      } else {
        existing.support++;
        existing.evidence.add(neighbor.row.id);
        if (weighted > existing.score) {
          existing.score = weighted;
          existing.source = neighbor.source;
          existing.distance = neighbor.distance;
        }
      }
    }
  }

  for (const [index, row] of priorRows().entries()) {
    const tag = { key: row.key, value: row.value };
    const id = `${tag.key}\u0000${valueNorm(tag.value)}`;
    if (current.has(id) || rejected.has(id) || aggregates.has(id)) continue;
    aggregates.set(id, {
      key: tag.key,
      value: tag.value,
      score: Math.min(0.4, 0.22 + row.count * 0.015) - index * 0.001,
      support: 1,
      evidence: new Set(),
      source: "recent",
    });
  }

  for (const face of faceSuggestionsForFile(file.id)) {
    const id = `people\u0000${valueNorm(face.person)}`;
    if (current.has(id) || rejected.has(id)) continue;
    const existing = aggregates.get(id);
    if (existing) {
      existing.score = Math.max(existing.score, face.confidence);
      existing.source = "face";
      existing.support++;
    } else {
      aggregates.set(id, {
        key: "people",
        value: face.person,
        score: face.confidence,
        support: 1,
        evidence: new Set(),
        source: "face",
      });
    }
  }

  return rankSuggestions(Array.from(aggregates.values()));
}

export function rankSuggestions(aggregates: Aggregate[]) {
  const groups = new Map<string, number>();
  const ranked = aggregates
    .map((aggregate) => {
      const supportBonus = Math.min(
        0.12,
        Math.max(0, aggregate.support - 1) * 0.03,
      );
      const score = Math.min(0.99, aggregate.score + supportBonus);
      return {
        key: aggregate.key,
        value: aggregate.value,
        score,
        reason: sourceReason(
          aggregate.source,
          aggregate.key,
          aggregate.value,
          aggregate.support,
          aggregate.distance,
        ),
        evidence: Array.from(aggregate.evidence).slice(0, 5),
      };
    })
    .filter((suggestion) => suggestion.score >= 0.3)
    .sort((a, b) => b.score - a.score);

  const result: typeof ranked = [];
  for (const suggestion of ranked) {
    const used = groups.get(suggestion.key) ?? 0;
    if (used >= capFor(suggestion.key)) continue;
    groups.set(suggestion.key, used + 1);
    result.push(suggestion);
  }
  return result;
}

export function suggestionsForFiles(files: FileRow[], date?: string) {
  return files.map((file) => ({
    file,
    suggestions: suggestionsForFile(file, date),
  }));
}

export function normalizeTagList(tags: Tag[]): Tag[] {
  return dedupeTags(tags);
}
