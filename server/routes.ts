import express, { type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tag } from "../shared/types";
import { isValidTag } from "../shared/tag-format";
import { config, isWithinAllowedRoots } from "./config";
import {
  countFiles,
  db,
  faceCount,
  fileRowById,
  getAllSettings,
  getMediaRoot,
  getSetting,
  listFileRows,
  rejectSuggestion,
  resetFacesProcessed,
  setMediaRoot,
  setSetting,
  summaryFromRow,
} from "./db";
import { indexState, scanMedia } from "./indexer";
import {
  absolutePathFor,
  getFaceThumbnail,
  getPreview,
  getThumbnail,
} from "./media";
import {
  detailForFile,
  removeTagEverywhere,
  renameTagValue,
  saveFileTags,
  tagKeys,
  tagValues,
  undoChange,
  updateKey,
} from "./tags";
import {
  extendBatch,
  getOrCreateBatch,
  markBatchItem,
  untaggedCount,
} from "./batch";
import { stats } from "./stats";
import {
  applyMigration,
  getMigrationRows,
  getMigrationState,
  setMappings,
  startMigrationScan,
  type MappingInput,
} from "./migration";
import { getTask, isTaskRunning, requestTaskCancel } from "./tasks";
import {
  automationRunCounts,
  confirmAutoTag,
  listReviewSuggestions,
  rejectReviewSuggestions,
  resetRejectedSuggestions,
  reviewCounts,
  startFaceAutomation,
  startFaceScan,
  startPlaceAutomation,
  startReviewApproval,
} from "./automation";
import {
  faceListForFile,
  facesAvailable,
  labelCluster,
  labelFace,
  peopleList,
  processFacesForFile,
  unknownFaceClusters,
} from "./faces";
import {
  pushConfigured,
  removeSubscription,
  saveSubscription,
  sendPush,
  vapidPublicKey,
} from "./push";
import type { PushSubscription } from "web-push";

export const router = express.Router();

function fail(res: Response, status: number, message: string) {
  res.status(status).json({ error: message });
}

function numberParam(value: string | string[] | undefined): number | null {
  const text = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(text ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: getSetting("timezone") || config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

router.get("/health", (_req, res) => {
  res.json({ ok: true, version: config.appVersion });
});

router.get("/status", (_req, res) => {
  const root = getMediaRoot();
  let configured = false;
  try {
    configured = Boolean(root && fs.statSync(root).isDirectory());
  } catch {
    configured = false;
  }
  const tagged = (
    db
      .prepare("SELECT COUNT(DISTINCT file_id) AS count FROM file_tags")
      .get() as { count: number }
  ).count;
  res.json({
    configured,
    mediaRoot: root,
    dataDir: config.dataDir,
    indexing: indexState,
    counts: {
      files: countFiles(),
      tagged,
      untagged: untaggedCount(),
      legacyPending: countFiles({ legacyPending: true }),
      faces: faceCount(),
    },
    versions: { app: config.appVersion, exiftool: "bundled" },
    facesEnabled: facesAvailable(),
    task: getTask(),
  });
});

const setupSchema = z.object({ mediaRoot: z.string().min(1) });

router.post("/setup", (req, res) => {
  const parsed = setupSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "A media folder path is required");
  const resolved = path.resolve(config.appRoot, parsed.data.mediaRoot);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return fail(res, 400, "That path is not a directory on the server");
  }
  if (!isWithinAllowedRoots(resolved))
    return fail(res, 400, "That path is outside the allowed media roots");
  const current = getMediaRoot();
  if (
    current &&
    current !== resolved &&
    (indexState.running || isTaskRunning())
  ) {
    return fail(
      res,
      409,
      "Wait for the current library task to finish before changing the media folder",
    );
  }
  setMediaRoot(resolved);
  scanMedia().catch(() => undefined);
  res.json({ ok: true, mediaRoot: resolved });
});

const settingsSchema = z.object({
  mediaRoot: z.string().min(1).optional(),
  dailyGoal: z.number().int().min(1).max(100).optional(),
  reminderTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
  timezone: z.string().min(1).optional(),
  suggestionRadiusM: z.number().int().min(50).max(20_000).optional(),
  facesEnabled: z.boolean().optional(),
  faceScanMode: z.enum(["on-demand", "background"]).optional(),
  faceAutoThreshold: z.number().min(0.3).max(0.99).optional(),
  faceAutoMargin: z.number().min(0).max(0.5).optional(),
  faceMinQuality: z.number().min(0).max(1).optional(),
  placeAutoRadiusM: z.number().int().min(1).max(20_000).optional(),
  placeReviewRadiusM: z.number().int().min(10).max(50_000).optional(),
});

router.get("/settings", (_req, res) => {
  const settings = getAllSettings();
  res.json({
    mediaRoot: getMediaRoot(),
    dailyGoal: Number(settings.dailyGoal ?? config.dailyGoal),
    reminderTime: settings.reminderTime ?? "19:00",
    timezone: settings.timezone ?? config.timezone,
    suggestionRadiusM: Number(
      settings.suggestionRadiusM ?? config.suggestionRadiusM,
    ),
    facesEnabled:
      (settings.facesEnabled ?? String(config.facesEnabled)) === "true",
    faceScanMode:
      settings.faceScanMode === "background" ? "background" : "on-demand",
    faceAutoThreshold: Number(
      settings.faceAutoThreshold ?? config.faceAutoThreshold,
    ),
    faceAutoMargin: Number(settings.faceAutoMargin ?? config.faceAutoMargin),
    faceMinQuality: Number(settings.faceMinQuality ?? config.faceMinQuality),
    placeAutoRadiusM: Number(
      settings.placeAutoRadiusM ?? config.placeAutoRadiusM,
    ),
    placeReviewRadiusM: Number(
      settings.placeReviewRadiusM ?? config.placeReviewRadiusM,
    ),
    pushConfigured: pushConfigured(),
    publicUrl: config.publicUrl,
  });
});

router.patch("/settings", (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success)
    return fail(
      res,
      400,
      parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  const input = parsed.data;
  if (input.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(
        new Date(),
      );
    } catch {
      return fail(res, 400, "That timezone is not recognized");
    }
  }
  let rootChanged = false;
  let resolvedRoot: string | null = null;
  if (input.mediaRoot) {
    const resolved = path.resolve(config.appRoot, input.mediaRoot);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return fail(res, 400, "That path is not a directory on the server");
    }
    if (!isWithinAllowedRoots(resolved))
      return fail(res, 400, "That path is outside the allowed media roots");
    rootChanged = getMediaRoot() !== resolved;
    if (rootChanged && indexState.running) {
      return fail(
        res,
        409,
        "Wait for the current library index to finish before changing the media folder",
      );
    }
    if (rootChanged && isTaskRunning()) {
      return fail(
        res,
        409,
        "Wait for the current task to finish before changing the media folder",
      );
    }
    if (rootChanged) resolvedRoot = resolved;
  }
  if (resolvedRoot) setMediaRoot(resolvedRoot);
  if (input.dailyGoal !== undefined)
    setSetting("dailyGoal", String(input.dailyGoal));
  if (input.reminderTime !== undefined)
    setSetting("reminderTime", input.reminderTime);
  if (input.timezone !== undefined) setSetting("timezone", input.timezone);
  if (input.suggestionRadiusM !== undefined)
    setSetting("suggestionRadiusM", String(input.suggestionRadiusM));
  if (input.facesEnabled !== undefined)
    setSetting("facesEnabled", input.facesEnabled ? "true" : "false");
  if (input.faceScanMode !== undefined)
    setSetting("faceScanMode", input.faceScanMode);
  if (input.faceAutoThreshold !== undefined)
    setSetting("faceAutoThreshold", String(input.faceAutoThreshold));
  if (input.faceAutoMargin !== undefined)
    setSetting("faceAutoMargin", String(input.faceAutoMargin));
  if (input.faceMinQuality !== undefined)
    setSetting("faceMinQuality", String(input.faceMinQuality));
  if (input.placeAutoRadiusM !== undefined)
    setSetting("placeAutoRadiusM", String(input.placeAutoRadiusM));
  if (input.placeReviewRadiusM !== undefined)
    setSetting("placeReviewRadiusM", String(input.placeReviewRadiusM));
  if (rootChanged) scanMedia().catch(() => undefined);
  res.json({ ok: true });
});

router.post("/index/rescan", (_req, res) => {
  if (indexState.running) {
    return res.json({
      ok: true,
      started: false,
      reason: "The library is already indexing",
      indexing: indexState,
    });
  }
  if (isTaskRunning()) {
    return fail(
      res,
      409,
      "Wait for the current long-running task to finish before rescanning",
    );
  }
  scanMedia().catch(() => undefined);
  res.json({ ok: true, started: true, indexing: indexState });
});

router.get("/batch/today", (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  res.json(getOrCreateBatch(date));
});

router.post("/batch/today/more", (req, res) => {
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  res.json(extendBatch(date));
});

const skipSchema = z.object({ date: z.string().optional() });
router.post("/files/:id/skip", (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid file id");
  const parsed = skipSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "Invalid request");
  markBatchItem(parsed.data.date ?? today(), id, "skipped");
  res.json({ ok: true });
});

router.get("/files", (req, res) => {
  const limit = Math.min(
    200,
    Math.max(1, Number.parseInt(String(req.query.limit ?? ""), 10) || 40),
  );
  const cursor =
    Number.parseInt(String(req.query.cursor ?? ""), 10) || undefined;
  const rows = listFileRows({
    q: typeof req.query.q === "string" ? req.query.q : undefined,
    tagged: req.query.tagged === "1" || req.query.tagged === "true",
    untagged: req.query.untagged === "1" || req.query.untagged === "true",
    legacyPending:
      req.query.legacyPending === "1" || req.query.legacyPending === "true",
    key: typeof req.query.key === "string" ? req.query.key : undefined,
    value: typeof req.query.value === "string" ? req.query.value : undefined,
    cursor,
    limit: limit + 1,
    sort:
      req.query.sort === "oldest" || req.query.sort === "name"
        ? req.query.sort
        : "newest",
  });
  const page = rows.slice(0, limit);
  res.json({
    files: page.map((row) => summaryFromRow(row)),
    cursor: page.at(-1)?.id ?? null,
    hasMore: rows.length > limit,
  });
});

router.get("/files/:id", (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid file id");
  const detail = detailForFile(id);
  if (!detail) return fail(res, 404, "File not found");
  res.json(detail);
});

const saveSchema = z.object({
  tags: z.array(z.object({ key: z.string(), value: z.string() })).max(200),
  description: z.string().max(20_000).default(""),
  date: z.string().optional(),
});

router.patch("/files/:id", async (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid file id");
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Invalid tags or description");
  const input = parsed.data;
  if (!input.tags.every((tag: Tag) => isValidTag(tag)))
    return fail(res, 400, "Invalid tag");
  const result = await saveFileTags(id, input.tags, input.description);
  markBatchItem(input.date ?? today(), id, "done");
  res.json({
    ...result.detail,
    undoId: result.undoId,
    metadataWritable: result.metadataWritable,
  });
});

router.post("/undo/:id", async (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid undo id");
  const detail = await undoChange(id);
  if (!detail) return fail(res, 404, "Undo entry not found or already used");
  const date = typeof req.body?.date === "string" ? req.body.date : today();
  markBatchItem(date, detail.id, "pending");
  res.json(detail);
});

const rejectSuggestionSchema = z.object({
  fileId: z.number().int().positive(),
  key: z.string().min(1),
  value: z.string().min(1),
  date: z.string().optional(),
});
router.post("/suggestions/reject", (req, res) => {
  const parsed = rejectSuggestionSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Invalid suggestion");
  rejectSuggestion(
    parsed.data.date ?? today(),
    parsed.data.fileId,
    parsed.data.key,
    parsed.data.value,
  );
  res.json({ ok: true });
});

router.get("/files/:id/thumb", async (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid file id");
  const row = fileRowById(id);
  if (!row) return fail(res, 404, "File not found");
  try {
    const thumb = await getThumbnail(row);
    res.setHeader("Cache-Control", "private, max-age=604800, immutable");
    res.sendFile(thumb);
  } catch {
    fail(res, 404, "Thumbnail unavailable");
  }
});

router.get("/files/:id/preview", async (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid file id");
  const row = fileRowById(id);
  if (!row) return fail(res, 404, "File not found");
  if (row.kind === "video") return res.redirect(`/api/files/${id}/thumb`);
  try {
    const preview = await getPreview(row);
    res.setHeader("Cache-Control", "private, max-age=604800, immutable");
    res.sendFile(preview);
  } catch {
    fail(res, 404, "Preview unavailable");
  }
});

router.get("/files/:id/media", (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid file id");
  const row = fileRowById(id);
  if (!row) return fail(res, 404, "File not found");
  const absolute = absolutePathFor(row);
  if (!absolute || !fs.existsSync(absolute))
    return fail(res, 404, "Media file not found");
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.sendFile(absolute);
});

router.get("/tags", (_req, res) => {
  res.json({ keys: tagKeys(), values: tagValues() });
});

const renameSchema = z.object({
  key: z.string(),
  from: z.string(),
  to: z.string(),
});
router.post("/tags/rename", async (req, res) => {
  const parsed = renameSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Invalid request");
  try {
    const result = await renameTagValue(
      parsed.data.key,
      parsed.data.from,
      parsed.data.to,
    );
    res.status(result.started ? 200 : 409).json(result);
  } catch (error) {
    fail(res, 400, error instanceof Error ? error.message : "Rename failed");
  }
});

const keySchema = z.object({ key: z.string(), multiValue: z.boolean() });
router.post("/tags/keys", (req, res) => {
  const parsed = keySchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Invalid request");
  try {
    updateKey(parsed.data.key, parsed.data.multiValue);
  } catch (error) {
    return fail(
      res,
      400,
      error instanceof Error ? error.message : "Invalid key",
    );
  }
  res.json({ ok: true });
});

const removeSchema = z.object({ key: z.string(), value: z.string() });
router.post("/tags/remove", async (req, res) => {
  const parsed = removeSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Invalid request");
  const result = await removeTagEverywhere(parsed.data.key, parsed.data.value);
  res.status(result.started ? 200 : 409).json(result);
});

const confirmTagSchema = z.object({ key: z.string(), value: z.string() });
router.post("/files/:id/tags/confirm", (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid file id");
  const parsed = confirmTagSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Invalid request");
  if (!confirmAutoTag(id, parsed.data.key, parsed.data.value))
    return fail(res, 404, "Auto-generated tag not found");
  res.json({ ok: true });
});

router.post("/automation/places/run", (_req, res) => {
  const result = startPlaceAutomation();
  res.status(result.started ? 200 : 409).json(result);
});

router.post("/automation/faces/run", (_req, res) => {
  const result = startFaceAutomation();
  res.status(result.started ? 200 : 409).json(result);
});

router.post("/automation/faces/scan", (req, res) => {
  const autoMatch = req.body?.autoMatch !== false;
  const result = startFaceScan({ autoMatch });
  res.status(result.started ? 200 : 409).json(result);
});

router.post("/automation/cancel", (_req, res) => {
  const task = getTask();
  if (
    !task ||
    !["face-scan", "face-auto", "place-auto", "review-apply"].includes(
      task.kind,
    )
  ) {
    return fail(res, 409, "No automation task is running");
  }
  if (!requestTaskCancel()) return fail(res, 409, "No task is running");
  res.json({ ok: true });
});

router.get("/automation/runs", (_req, res) => {
  res.json({ runs: automationRunCounts() });
});

router.get("/review/counts", (_req, res) => {
  res.json(reviewCounts());
});

router.get("/review/suggestions", (req, res) => {
  const kind =
    req.query.kind === "face" || req.query.kind === "place"
      ? req.query.kind
      : undefined;
  const cursor =
    Number.parseInt(String(req.query.cursor ?? ""), 10) || undefined;
  const limit = Number.parseInt(String(req.query.limit ?? ""), 10) || 60;
  res.json(listReviewSuggestions({ kind, cursor, limit }));
});

const reviewIdsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(500),
});
router.post("/review/approve", (req, res) => {
  const parsed = reviewIdsSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Select at least one suggestion");
  const result = startReviewApproval(parsed.data.ids);
  res.status(result.started ? 200 : 409).json(result);
});
router.post("/review/reject", (req, res) => {
  const parsed = reviewIdsSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Select at least one suggestion");
  res.json({ updated: rejectReviewSuggestions(parsed.data.ids) });
});
router.post("/review/reset-rejected", (_req, res) => {
  res.json({ deleted: resetRejectedSuggestions() });
});

router.get("/stats", (_req, res) => {
  res.json(stats());
});

router.get("/migration", (_req, res) => {
  res.json({ state: getMigrationState(), rows: getMigrationRows() });
});

router.post("/migration/scan", (_req, res) => {
  const result = startMigrationScan();
  res.status(result.started ? 200 : 409).json({
    ...result,
    rows: getMigrationRows(),
  });
});

const mappingSchema = z.object({
  mappings: z.array(
    z.object({
      legacyValue: z.string(),
      key: z.string(),
      value: z.string(),
      action: z.enum(["map", "skip"]),
    }),
  ),
});
router.post("/migration/map", (req, res) => {
  const parsed = mappingSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Invalid mapping");
  try {
    setMappings(parsed.data.mappings as MappingInput);
    res.json({ state: getMigrationState(), rows: getMigrationRows() });
  } catch (error) {
    fail(
      res,
      400,
      error instanceof Error ? error.message : "Could not save mapping",
    );
  }
});

const applyMigrationSchema = z.object({
  stripFilenames: z.boolean().default(true),
});
router.post("/migration/apply", (req, res) => {
  const parsed = applyMigrationSchema.safeParse(req.body ?? {});
  if (!parsed.success) return fail(res, 400, "Invalid request");
  const result = applyMigration(parsed.data);
  res
    .status(result.started ? 200 : 409)
    .json({ ...result, rows: getMigrationRows() });
});

router.get("/migration/state", (_req, res) => {
  res.json({ state: getMigrationState(), rows: getMigrationRows() });
});

router.get("/push/key", (_req, res) => {
  if (!pushConfigured())
    return fail(res, 400, "Push is not configured on the server");
  res.json({ publicKey: vapidPublicKey() });
});

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
router.post("/push/subscribe", (req, res) => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Invalid push subscription");
  saveSubscription(parsed.data as PushSubscription);
  res.json({ ok: true });
});

router.post("/push/unsubscribe", (req, res) => {
  const endpoint =
    typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
  if (endpoint) removeSubscription(endpoint);
  res.json({ ok: true });
});

router.post("/push/test", async (_req, res) => {
  const sent = await sendPush({
    title: "LifeTagger",
    body: "Notifications are working.",
    url: new URL("/today", config.publicUrl).href,
  });
  if (sent === 0) return fail(res, 400, "No push subscriptions are registered");
  res.json({ sent });
});

router.get("/faces/people", (_req, res) => {
  res.json({ people: peopleList() });
});

router.get("/faces/:id/thumb", async (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid face id");
  try {
    const thumb = await getFaceThumbnail(id);
    if (!thumb) return fail(res, 404, "Face thumbnail unavailable");
    res.setHeader("Cache-Control", "private, max-age=604800, immutable");
    res.sendFile(thumb);
  } catch {
    fail(res, 404, "Face thumbnail unavailable");
  }
});

router.get("/faces/clusters", (_req, res) => {
  res.json({ clusters: unknownFaceClusters() });
});

router.post("/files/:id/faces/process", async (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid file id");
  resetFacesProcessed(id);
  const row = fileRowById(id);
  if (!row) return fail(res, 404, "File not found");
  await processFacesForFile(row);
  res.json({ faces: faceListForFile(id), available: facesAvailable() });
});

const faceLabelSchema = z.object({ person: z.string().min(1).max(100) });
router.post("/faces/:id/label", async (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid face id");
  const parsed = faceLabelSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "A person name is required");
  const result = await labelFace(id, parsed.data.person);
  if (!result) return fail(res, 404, "Face not found");
  res.json({ ok: true, fileId: result.fileId });
});

router.post("/faces/:id/unlabel", async (req, res) => {
  const id = numberParam(req.params.id);
  if (!id) return fail(res, 400, "Invalid face id");
  const result = await labelFace(id, null);
  if (!result) return fail(res, 404, "Face not found");
  res.json({ ok: true });
});

const clusterLabelSchema = z.object({
  faceIds: z.array(z.number().int().positive()).min(1),
  person: z.string().min(1).max(100),
});
router.post("/faces/clusters/label", async (req, res) => {
  const parsed = clusterLabelSchema.safeParse(req.body);
  if (!parsed.success) return fail(res, 400, "Invalid request");
  const result = await labelCluster(parsed.data.faceIds, parsed.data.person);
  res.status(result.started ? 200 : 409).json(result);
});
