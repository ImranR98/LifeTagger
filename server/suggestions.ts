import type { Tag } from "../shared/types";
import type { FileRow } from "./db";
import {
  currentTagMutationVersion,
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
  | "global"
  | "face";

type Aggregate = {
  key: string;
  value: string;
  score: number;
  support: number;
  evidence: Set<number>;
  source: Source;
  distance?: number;
  lastUsed?: string;
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
  const trustedTags = tagsForFile(file.id).filter(
    (tag) => tag.source !== "face-auto" && tag.source !== "place-auto",
  );
  if (trustedTags.length > 0) {
    for (const row of filesSharingTags(file, trustedTags)) {
      add(row, 0.7, "co-occurrence");
    }
  }
  return Array.from(neighbors.values());
}

function keyWeight(key: string, source: Source): number {
  if (key === "place") {
    if (source === "gps") return 1;
    if (source === "same-folder") return 0.75;
    if (source === "same-day") return 0.55;
    if (source === "co-occurrence") return 0.7;
    return 0.3;
  }
  if (key === "event") {
    if (source === "same-day") return 1;
    if (source === "same-folder") return 0.9;
    if (source === "gps") return 0.8;
    if (source === "co-occurrence") return 0.65;
    return 0.4;
  }
  if (key === "people") {
    if (source === "same-day") return 1;
    if (source === "sequence") return 0.9;
    if (source === "same-folder") return 0.75;
    if (source === "gps") return 0.7;
    if (source === "co-occurrence") return 0.6;
    return 0.4;
  }
  if (key === "mood") {
    if (source === "co-occurrence") return 0.8;
    if (source === "same-day") return 0.55;
    return 0.35;
  }
  if (source === "face") return 1;
  if (source === "recent") return 0.45;
  if (source === "co-occurrence") return 0.7;
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

type PriorRow = {
  key: string;
  value: string;
  count: number;
  lastUsed: string;
  source: "recent" | "global";
};

let priorCache: {
  at: number;
  version: number;
  rows: PriorRow[];
} | null = null;

function priorRows(): PriorRow[] {
  const version = currentTagMutationVersion();
  if (
    !priorCache ||
    priorCache.version !== version ||
    Date.now() - priorCache.at > 30_000
  ) {
    const seen = new Set<string>();
    const rows: PriorRow[] = [];
    for (const row of recentTagCounts(30, 40)) {
      const id = `${row.key}\u0000${valueNorm(row.value)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ ...row, source: "recent" });
    }
    for (const row of globalTagCounts(40)) {
      const id = `${row.key}\u0000${valueNorm(row.value)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push({ ...row, source: "global" });
    }
    priorCache = { at: Date.now(), version, rows };
  }
  return priorCache.rows;
}

const DAY_MS = 86_400_000;

function recencyBoost(lastUsed: string): number {
  const age = Date.now() - Date.parse(lastUsed);
  if (!Number.isFinite(age)) return 0;
  if (age <= DAY_MS) return 0.22;
  if (age <= 7 * DAY_MS) return 0.14;
  if (age <= 30 * DAY_MS) return 0.06;
  return 0;
}

function isRecent(lastUsed: string | undefined, days: number): boolean {
  if (!lastUsed) return false;
  const age = Date.now() - Date.parse(lastUsed);
  return Number.isFinite(age) && age <= days * DAY_MS;
}

export function clearSuggestionCache(): void {
  priorCache = null;
}

export function suggestionsForFile(
  file: FileRow,
  date?: string,
): ReturnType<typeof rankSuggestions> {
  const fileTags = tagsForFile(file.id);
  const current = new Set(
    fileTags.map((tag) => `${tag.key}\u0000${valueNorm(tag.value)}`),
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
      if (tag.source === "face-auto" || tag.source === "place-auto") continue;
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

  for (const row of priorRows()) {
    const id = `${row.key}\u0000${valueNorm(row.value)}`;
    if (current.has(id) || rejected.has(id) || aggregates.has(id)) continue;
    const recent = row.source === "recent";
    aggregates.set(id, {
      key: row.key,
      value: row.value,
      score: recent
        ? Math.min(
            0.99,
            0.34 +
              Math.min(0.14, row.count * 0.02) +
              recencyBoost(row.lastUsed),
          )
        : Math.min(0.4, 0.22 + row.count * 0.015),
      support: 1,
      evidence: new Set(),
      source: row.source,
      lastUsed: row.lastUsed,
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
        source: aggregate.source,
        lastUsed: aggregate.lastUsed,
      };
    })
    .filter((suggestion) => suggestion.score >= 0.3)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.lastUsed ? Date.parse(b.lastUsed) : 0) -
          (a.lastUsed ? Date.parse(a.lastUsed) : 0),
    );

  const byKey = new Map<string, typeof ranked>();
  for (const suggestion of ranked) {
    const list = byKey.get(suggestion.key) ?? [];
    list.push(suggestion);
    byKey.set(suggestion.key, list);
  }

  const result: typeof ranked = [];
  for (const [key, suggestions] of byKey) {
    const cap = capFor(key);
    const selected = suggestions.slice(0, cap);
    // Reserve slots for recently used tags, so newly added values can
    // displace stale suggestions even when a key is already at its cap.
    if (selected.length === cap) {
      const excludedRecent = suggestions
        .slice(cap)
        .filter(
          (suggestion) =>
            suggestion.source === "recent" && isRecent(suggestion.lastUsed, 14),
        )
        .sort(
          (a, b) =>
            (b.lastUsed ? Date.parse(b.lastUsed) : 0) -
            (a.lastUsed ? Date.parse(a.lastUsed) : 0),
        );
      for (const recent of excludedRecent) {
        const replaceAt = selected
          .map((suggestion, index) => ({ suggestion, index }))
          .filter(
            ({ suggestion }) =>
              !(
                suggestion.source === "recent" &&
                isRecent(suggestion.lastUsed, 14)
              ),
          )
          .sort((a, b) => a.suggestion.score - b.suggestion.score)[0]?.index;
        if (replaceAt === undefined) break;
        selected[replaceAt] = recent;
      }
    }
    result.push(...selected);
  }
  result.sort(
    (a, b) =>
      b.score - a.score ||
      (b.lastUsed ? Date.parse(b.lastUsed) : 0) -
        (a.lastUsed ? Date.parse(a.lastUsed) : 0),
  );
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
