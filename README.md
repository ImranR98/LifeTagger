# LifeTagger
> Add searchable tags to your vast media library, one batch at a time.

It's the 2020s and over the years, you've ammassed a lifetime of photos and videos. Sounds great, but without a way to actually search through it all, your vast library of memories is about as useful as [Write-Only Memory](https://en.wikipedia.org/wiki/Write-only_memory_(joke)). You could, of course, rely on a service like Google Photos that uses machine-learning magic to tag items for you, but this method is far from perfect and - more importantly - relies on a shady for-profit company which produces non-portable results that will lock you in to their platform.

No, the only solution is to quit your job, retreat to an isolated mountain, and spend the next few months combing through each file and tagging it manually. Or you could use LifeTagger.

LifeTagger breaks the task out into manageable chunks. Point it to your media folder and it will present a list of media files in a Web-based GUI; it suggests tags based on the context of what you have already tagged (same day, nearby location, filename sequence, folder, and faces), and writes the tags you accept to the file's metadata as key-value pairs. The idea is to do this a few files at a time and turn this into a daily habit that, while only taking up a minute of your time a day, will - in a few years - result in a media library that will be fully searchable for life - no matter what storage medium or cloud platform you save them to.

## Setup
0. Install [Node.js](https://nodejs.org/en/) on your PC (Node.js 24 or newer). ExifTool needs `perl`; `ffmpeg` is optional and only used for video posters.
1. Copy the `template.env` file and rename the copy to `app.env`.
2. Fill `app.env` in with appropriate information as described in that file (replace the descriptions after the `=` with your actual info).
3. Install the server and client dependencies by running `npm install` in a terminal (opened in the LifeTagger folder).
4. Build the client by running `npm run build`.
5. Start the server by running `npm start`.
6. Launch your browser and open `http://localhost:8080`. If the media folder is not configured yet, the setup screen will ask for it. Tag a few files, one at a time.
7. Stop the server by pressing `Ctrl-C` in the terminal.
8. Repeat steps 5-7 at least once per day - set a reminder on your phone, a sticky note on your fridge, or hire someone to remind you by knocking on your window every morning idk.

## More Details
- Tags are stored in the file's `XMP-dc:Subject` metadata and mirrored to `IPTC:Keywords` as `key=value` entries:
    ```
    people=John R
    people=Kelly Ann
    place=John's place in Cuba
    event=Cuba 2019
    mood=funny
    ```
    Repeated keys are treated as lists. Values can contain spaces, commas, apostrophes, and Unicode. The plain-text `Description` field is separate from tags and remains available for notes.
- Tags are no longer appended to filenames. The old `filename-[tag1, tag2, tag3].jpeg` convention is only read by the migration wizard; files using it are held out of the daily batch until you map their legacy strings to key-value tags. Normal tagging never renames a file.
- The **Migration** page is linked from the sidebar and from a banner whenever legacy files are waiting. It scans automatically in the background, shows progress, lets you assign an editable key/value (or skip) for every distinct old string, and saving is automatic when you press Apply. Stripping the old filename suffix is optional, but a retained suffix can be detected as legacy again by a later scan.
- Suggestions are one-tap chips with a reason and confidence. They come from same-day photos, nearby GPS coordinates, burst/filename sequence, folder habits, tag co-occurrence, recently used tags, and local face matches. Nothing is applied silently.
- Face recognition is local. It works on photos and on video poster frames, and naming a face once lets LifeTagger suggest that person on later items. No face data leaves the server.
- The **Review** page runs two automation modes. High-confidence known faces are matched across the library, and places are propagated to nearby photos using GPS distance. Lower-confidence matches wait in a thumbnail-only multi-select queue for bulk approval or rejection. Auto-generated tags are marked `AUTO` in the UI and are never used as references for further automation until you confirm them with a review approval.
- Files whose only tags are auto-generated still appear in the daily review by default. Saving them confirms the auto tags, even if you did not edit them. The Today page has a **Review auto-tagged items** toggle to skip them. The count summary shows tagged, manually tagged, and indexed files.
- **Scan all faces** is a separate background job for the whole library. It can take hours, shows progress, and can be cancelled and resumed.
- The Library defaults to **Tagged**, with **Tagged / Untagged / All** filters for browsing the rest. The installable PWA can also send a Web Push reminder when the daily batch is unfinished (VAPID keys required).
- File format support: JPEG/JPG, PNG, TIFF/TIF, WebP, GIF, AVIF, HEIC/HEIF, BMP, JPEG 2000, JXL, PSD, and common RAW formats; MP4, M4V, MOV, AVI, MKV, WebM, 3GP, 3G2, MTS/M2TS/TS, MPG/MPEG, WMV/ASF, FLV/F4V, OGV, VOB, and RM/RMVB videos. MP4/MOV/3GP metadata writes are supported where ExifTool supports them. Some containers (notably MKV/WebM) cannot be written by ExifTool; those tags are kept in LifeTagger's index, shown with an `index-only` warning, and preserved across rescans. HEIC/RAW originals are displayed through generated JPEG previews, and browser playback of unusual video codecs varies by browser. Add custom extensions with `EXTRA_IMAGE_EXT` or `EXTRA_VIDEO_EXT`.
- It may not always be possible to write data to a file's `Description` or tag metadata; in that case the tags are kept in the index and the file detail warns you that they were not written to the file.
- Metadata writes are backed up under `DATA_DIR/metadata-backups`, and the last change can be undone from the UI. The SQLite index and daily database snapshots live in `DATA_DIR`.
