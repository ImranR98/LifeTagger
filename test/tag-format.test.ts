import test from "node:test";
import assert from "node:assert/strict";
import {
  dedupeTags,
  formatTag,
  groupTags,
  hasLegacyTags,
  normalizeKey,
  parseLegacyFilename,
  parseTagEntry,
  splitLegacyDescription,
  tagsEqual,
  valueNorm,
} from "../shared/tag-format";

test("parses and formats key-value metadata entries", () => {
  assert.deepEqual(parseTagEntry("people=John R"), {
    key: "people",
    value: "John R",
  });
  assert.deepEqual(parseTagEntry("place=John's place in Cuba"), {
    key: "place",
    value: "John's place in Cuba",
  });
  assert.deepEqual(parseTagEntry("note=a=b"), { key: "note", value: "a=b" });
  assert.deepEqual(parseTagEntry("beach"), { key: "keyword", value: "beach" });
  assert.equal(parseTagEntry("   "), null);
  assert.deepEqual(parseTagEntry("bad key=value"), {
    key: "bad-key",
    value: "value",
  });
  assert.equal(parseTagEntry("1key=value"), null);
  assert.equal(
    formatTag({ key: "people", value: " John R " }),
    "people=John R",
  );
});

test("normalizes keys and compares values case-insensitively", () => {
  assert.equal(normalizeKey(" People "), "people");
  assert.equal(normalizeKey("My Key"), "my-key");
  assert.equal(valueNorm("John   R"), "john r");
  assert.equal(
    tagsEqual(
      [
        { key: "people", value: "John R" },
        { key: "place", value: "Cuba" },
      ],
      [
        { key: "place", value: "cuba" },
        { key: "people", value: "john r" },
      ],
    ),
    true,
  );
});

test("dedupes and groups list values", () => {
  const tags = dedupeTags([
    { key: "people", value: "John R" },
    { key: "people", value: "john r" },
    { key: "people", value: "Kelly Ann" },
    { key: "place", value: "Cuba" },
  ]);
  assert.equal(tags.length, 3);
  const groups = groupTags(tags);
  assert.deepEqual(groups.find((group) => group.key === "people")?.values, [
    "John R",
    "Kelly Ann",
  ]);
});

test("parses the old filename convention", () => {
  assert.deepEqual(parseLegacyFilename("photo-[beach, sun].jpg"), {
    baseName: "photo",
    extension: ".jpg",
    tags: ["beach", "sun"],
    newName: "photo.jpg",
  });
  assert.deepEqual(parseLegacyFilename("photo-2019-[Cuba].jpeg")?.tags, [
    "Cuba",
  ]);
  assert.equal(parseLegacyFilename("photo.jpg"), null);
  assert.equal(parseLegacyFilename("photo-[].jpg"), null);
});

test("detects legacy tags without misreading normal prose", () => {
  assert.equal(hasLegacyTags("photo-[beach, sun].jpg", ""), true);
  assert.equal(hasLegacyTags("photo.jpg", "beach, sun. A day"), true);
  assert.equal(hasLegacyTags("photo.jpg", "beach. A day"), false);
  assert.equal(hasLegacyTags("photo-[beach].jpg", "beach. A day"), true);
  assert.equal(
    hasLegacyTags("photo.jpg", "Hello. A normal description"),
    false,
  );
});

test("only splits old tag prefixes from descriptions", () => {
  assert.deepEqual(splitLegacyDescription("beach, sun. A day at the beach"), {
    tags: ["beach", "sun"],
    description: "A day at the beach",
  });
  assert.deepEqual(
    splitLegacyDescription("A normal sentence. With punctuation."),
    {
      tags: [],
      description: "A normal sentence. With punctuation.",
    },
  );
  assert.deepEqual(splitLegacyDescription("beach. no other tags"), {
    tags: [],
    description: "beach. no other tags",
  });
  assert.deepEqual(
    splitLegacyDescription("beach. no other tags", { allowSingle: true }),
    {
      tags: ["beach"],
      description: "no other tags",
    },
  );
  assert.deepEqual(
    splitLegacyDescription("Hello. A normal description", {
      allowSingle: true,
      filenameTags: ["beach"],
    }),
    {
      tags: [],
      description: "Hello. A normal description",
    },
  );
});
