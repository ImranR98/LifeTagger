import type { Tag } from "./types";

/** Keys that are conventionally multi-valued. Any key may repeat, but the UI treats these as lists. */
export const MULTI_VALUE_KEYS = new Set([
  "people",
  "person",
  "objects",
  "object",
  "activities",
  "activity",
]);

export const DEFAULT_KEYS = [
  "people",
  "place",
  "event",
  "mood",
  "activity",
  "object",
  "keyword",
];

export const TAG_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const TAG_VALUE_FORBIDDEN = /[\u0000-\u001f\u007f]/;

export function normalizeKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

export function normalizeValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function valueNorm(value: string): string {
  return normalizeValue(value).normalize("NFC").toLocaleLowerCase();
}

export function isValidTag(tag: Tag): boolean {
  return (
    TAG_KEY_RE.test(tag.key) &&
    tag.value.length > 0 &&
    tag.value.length <= 200 &&
    !TAG_VALUE_FORBIDDEN.test(tag.value)
  );
}

/** Parse an XMP Subject entry. Splits on the first '=' only, so values may contain '='. */
export function parseTagEntry(entry: string): Tag | null {
  const text = entry.trim();
  if (!text) return null;
  const index = text.indexOf("=");
  if (index < 0) {
    const value = normalizeValue(text);
    return value ? { key: "keyword", value } : null;
  }
  const key = normalizeKey(text.slice(0, index));
  const value = normalizeValue(text.slice(index + 1));
  if (!TAG_KEY_RE.test(key) || !value || TAG_VALUE_FORBIDDEN.test(value))
    return null;
  return { key, value };
}

export function formatTag(tag: Tag): string {
  return `${tag.key}=${normalizeValue(tag.value)}`;
}

export function dedupeTags(tags: Tag[]): Tag[] {
  const seen = new Set<string>();
  const result: Tag[] = [];
  for (const raw of tags) {
    const key = normalizeKey(raw.key);
    const value = normalizeValue(raw.value);
    if (!TAG_KEY_RE.test(key) || !value) continue;
    const id = `${key}\u0000${valueNorm(value)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ key, value });
  }
  return sortTags(result);
}

export function sortTags(tags: Tag[]): Tag[] {
  return [...tags].sort(
    (a, b) => a.key.localeCompare(b.key) || a.value.localeCompare(b.value),
  );
}

export function compareTags(a: Tag, b: Tag): boolean {
  return a.key === b.key && valueNorm(a.value) === valueNorm(b.value);
}

export function tagsEqual(a: Tag[], b: Tag[]): boolean {
  const left = dedupeTags(a);
  const right = dedupeTags(b);
  if (left.length !== right.length) return false;
  return left.every((tag, index) => compareTags(tag, right[index]!));
}

const LEGACY_FILENAME_RE = /^(.*)-\[([^\]]*)\](\.[^./\\]+)$/;

export type LegacyFilename = {
  baseName: string;
  extension: string;
  tags: string[];
  newName: string;
};

/** Parse the old `name-[tag1, tag2].jpg` convention. */
export function parseLegacyFilename(filename: string): LegacyFilename | null {
  const match = LEGACY_FILENAME_RE.exec(filename);
  if (!match) return null;
  const [, base = "", inner = "", extension = ""] = match;
  const tags = inner
    .split(",")
    .map((tag) => normalizeValue(tag))
    .filter(Boolean);
  if (tags.length === 0) return null;
  return {
    baseName: base,
    extension,
    tags,
    newName: `${base}${extension}`,
  };
}

const LEGACY_DESCRIPTION_RE =
  /^((?:[A-Za-z0-9_-]+(?:\s*,\s*)?)+)\.\s+([\s\S]*)$/;

/** Split the old `${tags}. ${description}` convention without touching normal prose.
 * A single bare word is only treated as a tag when `allowSingle` is set (e.g. when the
 * filename also carries the legacy suffix). */
export function splitLegacyDescription(
  description: string,
  options: { allowSingle?: boolean; filenameTags?: string[] } = {},
): { tags: string[]; description: string } {
  const trimmed = description.trim();
  if (!trimmed) return { tags: [], description: "" };
  const match = LEGACY_DESCRIPTION_RE.exec(trimmed);
  if (!match) return { tags: [], description: trimmed };
  const [, rawTags = "", rest = ""] = match;
  const tags = rawTags
    .split(",")
    .map((tag) => normalizeValue(tag))
    .filter((tag) => /^[A-Za-z0-9_-]+$/.test(tag));
  if (tags.length === 0) return { tags: [], description: trimmed };
  if (tags.length === 1 && !rawTags.includes(",") && !options.allowSingle) {
    return { tags: [], description: trimmed };
  }
  if (
    options.filenameTags &&
    tags.length > 0 &&
    !tags.every((tag) =>
      options.filenameTags!.some(
        (filenameTag) => valueNorm(filenameTag) === valueNorm(tag),
      ),
    )
  ) {
    return { tags: [], description: trimmed };
  }
  return { tags, description: rest.trim() };
}

/** True when a filename or description still uses the old plain-string tag convention. */
export function hasLegacyTags(filename: string, description: string): boolean {
  const legacyFilename = parseLegacyFilename(filename);
  const legacyDescription = splitLegacyDescription(description, {
    allowSingle: Boolean(legacyFilename),
    filenameTags: legacyFilename?.tags,
  });
  return legacyFilename !== null || legacyDescription.tags.length > 0;
}

/** Group tags for the editor and chips UI. */
export function groupTags(tags: Tag[]): { key: string; values: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const tag of tags) {
    const values = groups.get(tag.key) ?? [];
    if (!values.some((value) => valueNorm(value) === valueNorm(tag.value)))
      values.push(tag.value);
    groups.set(tag.key, values);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => ({
      key,
      values: values.sort((a, b) => a.localeCompare(b)),
    }));
}
