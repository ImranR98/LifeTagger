# LifeTagger

> Add searchable tags to your media library, a few photos at a time.

LifeTagger v2 is a metadata-first media tagger. Tags are stored in the files
themselves as key-value pairs, the app suggests tags from the context of what
you have already tagged, and a daily batch keeps the job small enough to
actually finish.

The old Angular UI and filename-based tagging have been removed. Filenames are
never renamed by normal tagging.

## What changed

- **Tags are key-value metadata**, stored in `XMP-dc:Subject` and mirrored to
  `IPTC:Keywords` for compatibility:
  ```
  people=John R
  people=Kelly Ann
  place=John's place in Cuba
  event=Cuba 2019
  mood=funny
  ```
  Repeated keys are lists. Values can contain spaces, commas, apostrophes, and
  Unicode. The old `name-[tag1, tag2].jpg` convention is only used by the
  migration wizard.
- **A local index** in SQLite makes search, suggestions, and daily batches fast.
  Tags live in the media files; the database is a cache plus app state.
- **Suggestions** come from same-day photos, GPS proximity, burst/filename
  sequence, folder habits, tag co-occurrence, recently used tags, and local face
  matches. Every suggestion explains itself; nothing is applied silently.
- **A mobile-first PWA** with a Today batch, one-tap suggestion chips, a library
  search, tag vocabulary management, stats/streaks, and Web Push reminders. The
  Library defaults to tagged items; switch its filter to Untagged or All when
  you need the backlog.
- **Local face recognition** using Human/InsightFace models. Faces are detected
  on demand (or in the background if you choose), named once, and then suggested
  in later photos and videos. Video face detection uses the poster frame. No
  face data leaves the server.
- **A guided migration** from the old plain-string tags. The Migration page
  scans automatically, shows every distinct legacy string, and lets you assign
  an editable key/value or mark it as skipped. Apply saves the current mapping
  automatically and optionally strips the old filename suffix.

## Quick start (local)

Requirements: Node.js 24+ and `perl` for ExifTool. `ffmpeg` is optional and only
needed for video posters (thumbnail placeholders appear without it).

```bash
cp template.env app.env
# edit app.env: MEDIA_ROOT, DATA_DIR, optional VAPID keys
npm install
npm run dev
```

Vite runs at <http://localhost:5173> and proxies `/api` to the server on
`localhost:8080`. For a production-style local run:

```bash
npm run build
npm start
```

Open <http://localhost:8080>. If the media path is not configured yet, the setup
screen asks for it. Indexing runs in the background and is safe to interrupt.

## Production deployment

The intended target is the `srv0` K3s stack behind Authelia. See
[`deploy/README.md`](deploy/README.md) for the full template, values, media PVC,
app-data PVC, VAPID secret, and `validate.sh`/`deploy.sh` flow.

The container image is published to `ghcr.io/imranr98/lifetagger` by GitHub
Actions. It is a single Node process with SQLite; keep one replica.

Required production env:

| Variable                                                   | Purpose                                       |
| ---------------------------------------------------------- | --------------------------------------------- |
| `MEDIA_ROOT=/media`                                        | mounted media library                         |
| `ALLOWED_MEDIA_ROOTS=/media`                               | restricts setup to the mounted volume         |
| `DATA_DIR=/data`                                           | SQLite, thumbnails, previews, models, backups |
| `PUBLIC_URL=https://lifetagger.<domain>`                   | push notification URLs                        |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push                                      |
| `TZ`                                                       | daily batch and reminder timezone             |

See `template.env` for the rest. The app itself intentionally has no login; it
relies on the Authelia forward-auth route at the edge.

## How tagging works

When you save a file, LifeTagger:

1. validates and normalizes the tag list;
2. snapshots the current metadata to `DATA_DIR/metadata-backups`;
3. writes `Subject`, `Keywords`, and `Description` through ExifTool;
4. reads the file back to verify the write;
5. updates SQLite and records an undo entry.

If a format does not accept metadata (some videos/RAW variants), the tags are
kept in the index and the UI warns that they were not written to the file. Those
index-only tags are preserved across rescans, and the file detail shows an
`index-only` warning.

Tags are written as `key=value` entries in `Subject`. ExifTool mirrors the same
list to `Keywords`, so both fields agree. There is no custom binary format, no
sidecar dependency, and no filename renaming.

## Daily loop and suggestions

- Today's batch is small and stable for the day. It starts with the oldest
  untagged files and pulls in same-day/same-folder/same-place neighbors so the
  batch feels like a coherent set.
- Suggestions for a file are ranked from nearby and same-day tagged files.
  GPS distance, time proximity, sequence, folder consistency, co-occurrence, and
  face matches all contribute. The strongest reason is displayed on each chip.
- Rejected suggestions are remembered for that file/day.
- “Review more” extends the batch. The completion screen shows the streak.
- There is no bulk “apply to the rest of the batch” action: you only tag files
  you have actually reviewed. Use the Tag manager for vocabulary-wide renames
  and merges instead.
- Web Push sends one reminder at the configured local time, and only if the
  batch is still unfinished. The server must be running (the K8s deployment is
  always on).

## Format compatibility

The indexer uses an extension allowlist; sidecars and unknown files are ignored. The built-in lists cover:

- **Images:** JPG/JPEG/JPE/JFIF, PNG, GIF, WebP, AVIF, HEIC/HEIF, TIF/TIFF, BMP, JPEG 2000, JXL, PSD, and common RAW formats (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, PEF, SRW, X3F).
- **Video:** MP4, M4V, MOV, AVI, MKV, WebM, 3GP, 3G2, MTS/M2TS/TS, MPG/MPEG, WMV/ASF, FLV/F4V, OGV, VOB, RM/RMVB.

What actually works per format:

| Area                 | Behaviour                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| XMP/EXIF tag writing | JPEG, TIFF, PNG, WebP, HEIC/HEIF, MP4/M4V/MOV/3GP usually accept writes. Some AVI/MKV/WebM/MPEG/RAW variants are read-only or partially supported. LifeTagger verifies every write; if it fails, tags are kept in the index and the file detail shows an `index-only` warning. |
| Thumbnails/previews  | `sharp` handles common raster formats. Unsupported images fall back to an embedded preview extracted by ExifTool. Videos get a poster frame via `ffmpeg`. RAW/HEIC originals are shown through generated JPEG previews.                                                        |
| Browser playback     | MP4/MOV/M4V with H.264/AAC are broadly supported; MKV, AVI, 3GP, MPEG, WMV, and others depend on the browser codecs. The poster and tag UI still work even when playback does not.                                                                                             |
| Face recognition     | Videos are checked using their poster frame, not a scan of every frame. Photos use the generated preview. A poster-frame face can be named, matched, and suggested like any photo face.                                                                                        |
| Verified examples    | JPEG/PNG and MP4/MOV/M4V/3GP metadata round-trips work. WebM and MKV are indexed, thumbnailed, searched, and tagged in LifeTagger, but ExifTool cannot write their metadata, so they remain index-only. AVI/MPEG/WMV and some RAW variants vary the same way.                  |
| Custom formats       | Add extensions to `EXTRA_IMAGE_EXT` or `EXTRA_VIDEO_EXT` (comma-separated) and rescan. Use `EXCLUDE_EXT` to suppress anything.                                                                                                                                                 |

The original file is never converted or renamed by normal tagging. HEIC/RAW/video display limitations only affect the review UI, not the stored metadata.

## Migration from the old app

The old tags were bare strings, so the mapping is never guessed automatically.

1. Open **Migration** from the sidebar, or the banner that appears whenever
   legacy files are waiting. The page scans automatically and is available from
   Settings too.
2. Map each unique string to a key and value, or mark it as skipped. The table
   supports bulk key assignment and editable values; mappings can be exported
   and imported as JSON.
3. Press **Apply**. The current table is saved automatically first, so you do
   not need to press Save mapping separately. Metadata is written per file and
   verified before the optional filename suffix strip. A rename log and metadata
   backups make this recoverable.
4. Files with unmapped legacy tags stay out of daily batches. If Apply reports
   missing keys, the banner tells you exactly how many rows still need one.

CLI flow:

```bash
npm run migrate:scan > legacy.json
# mapping.json is an array like:
# [{ "legacyValue": "beach", "key": "activity", "value": "swimming", "action": "map" }]
npm run migrate:map -- mapping.json
npm run migrate:apply            # strip old suffixes
npm run migrate:apply -- --no-strip
```

Stop the server while running a large CLI migration to avoid write contention.

## Development

```bash
npm test              # server/shared unit tests
npm run typecheck     # server + web
npm run build         # web bundle + server bundle
npm run dev           # server watch + Vite
npm run format        # Prettier over server, shared, web/src, and tests
```

Layout:

```
server/     Express API, SQLite, ExifTool, indexer, suggestions, faces, push
shared/     Tag grammar, shared types
web/        React + Vite + Tailwind PWA
deploy/     srv0 Kubernetes template and deployment notes
test/       Unit tests
```

## Safety and backups

- Media is the source of truth. Back up the media tree as usual.
- Back up `DATA_DIR/lifetagger.db` (or the daily snapshots) and
  `DATA_DIR/metadata-backups` for undo history and face labels.
- The app never deletes media. The database can be rebuilt from the files if
  the tag metadata is intact; face labels are app state and live in the DB.
- Use the Tag manager to merge spelling variants so suggestions stay useful.
- Face recognition is local and can be disabled in Settings. Model licenses belong to the upstream
  projects; see `@vladmandic/human` and InsightFace for details.

## Limitations

- Indexing a six-figure library takes time; it runs in the background and only
  reads changed files after the first pass.
- Browsers cannot display every format (e.g. some HEIC/RAW); LifeTagger generates
  JPEG previews and posters where it can.
- The review UI is media-first; very large videos stream the original rather than
  transcoding a proxy.
- Video face detection is poster-frame only. Detecting faces across the whole
  timeline would require a separate frame-sampling job.
- Library defaults to Tagged. Use the Tagged / Untagged / All filter for the
  rest of the library.
- PWA installation and Web Push require HTTPS. Localhost is exempt; a phone on
  plain LAN HTTP is not.
