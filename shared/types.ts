export type Tag = { key: string; value: string };

export type TagSuggestion = {
  key: string;
  value: string;
  score: number;
  reason: string;
  evidence?: number[];
};

export type MediaKind = "image" | "video";

export type Face = {
  id: number;
  fileId: number;
  bbox: { x: number; y: number; w: number; h: number };
  label: string | null;
  confidence: number;
};

export type FileSummary = {
  id: number;
  name: string;
  path: string;
  folder: string;
  kind: MediaKind;
  size: number;
  captureAt: string | null;
  localDate: string | null;
  gps: { lat: number; lon: number } | null;
  tags: Tag[];
  legacyPending: boolean;
  thumbUrl: string;
  previewUrl: string;
  mediaUrl: string;
  faces?: Face[];
};

export type FileDetail = FileSummary & {
  description: string;
  metadataWritable: boolean;
  camera: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  indexedAt: string;
};

export type SuggestionFeedback = {
  key: string;
  value: string;
  action: "accepted" | "rejected";
};

export type BatchItem = FileSummary & {
  suggestions: TagSuggestion[];
  description: string;
};

export type BatchResponse = {
  date: string;
  goal: number;
  done: number;
  total: number;
  caughtUp: boolean;
  facesPending: number;
  items: BatchItem[];
};

export type StatsResponse = {
  streak: number;
  longestStreak: number;
  totalTagged: number;
  totalFiles: number;
  indexedFiles: number;
  pendingBatches: number;
  last30Days: { date: string; done: number }[];
  topKeys: { key: string; count: number }[];
};

export type MigrationTagRow = {
  legacyValue: string;
  count: number;
  sources: string[];
  samples: string[];
  mapped: { key: string; value: string; action: "map" | "skip" }[];
};

export type MigrationState = {
  scanned: boolean;
  needsScan: boolean;
  legacyFiles: number;
  legacyTags: number;
  appliedFiles: number;
  pendingFiles: number;
  running: boolean;
  mode: "scan" | "apply" | null;
  errors: number;
  processed: number;
  total: number;
  lastError: string | null;
};

export type TaskKind =
  | "migration-scan"
  | "migration-apply"
  | "tag-rename"
  | "tag-remove"
  | "cluster-label";

export type TaskState = {
  kind: TaskKind;
  running: boolean;
  processed: number;
  total: number;
  errors: number;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
};

export type StatusResponse = {
  configured: boolean;
  mediaRoot: string | null;
  dataDir: string;
  indexing: {
    running: boolean;
    scanned: number;
    total: number;
    indexed: number;
    errors: number;
  };
  counts: {
    files: number;
    tagged: number;
    untagged: number;
    legacyPending: number;
    faces: number;
  };
  versions: { app: string; exiftool: string };
  facesEnabled: boolean;
  task: TaskState | null;
};

export type SettingsResponse = {
  mediaRoot: string | null;
  dailyGoal: number;
  reminderTime: string;
  timezone: string;
  suggestionRadiusM: number;
  facesEnabled: boolean;
  faceScanMode: "on-demand" | "background";
  pushConfigured: boolean;
  publicUrl: string;
};
