import type {
  BatchResponse,
  FileDetail,
  FileSummary,
  MigrationState,
  MigrationTagRow,
  SettingsResponse,
  StatsResponse,
  StatusResponse,
  Tag,
  TagSuggestion,
} from "@shared/types";

export class AuthRequiredError extends Error {
  constructor() {
    super("Your session has expired. Reload the page to sign in again.");
  }
}

export class NetworkError extends Error {
  constructor() {
    super("Could not reach LifeTagger. Check your connection and try again.");
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      // Do not follow a reverse-proxy login redirect from an API request.
      // A manual redirect is detectable, while a followed one would return the
      // login page or fail CORS and look like a generic network error.
      redirect: "manual",
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new NetworkError();
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (
    response.type === "opaqueredirect" ||
    response.status === 401 ||
    response.status === 403 ||
    response.redirected ||
    !contentType.includes("application/json")
  ) {
    throw new AuthRequiredError();
  }
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function query(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const api = {
  status: () => request<StatusResponse>("/api/status"),
  setup: (mediaRoot: string) =>
    request<{ ok: boolean; mediaRoot: string }>("/api/setup", {
      method: "POST",
      body: JSON.stringify({ mediaRoot }),
    }),
  settings: () => request<SettingsResponse>("/api/settings"),
  updateSettings: (
    patch: Partial<SettingsResponse> & {
      facesEnabled?: boolean;
      faceScanMode?: string;
    },
  ) =>
    request<{ ok: boolean }>("/api/settings", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  rescan: () => request<unknown>("/api/index/rescan", { method: "POST" }),

  batch: (date?: string) =>
    request<BatchResponse>(`/api/batch/today${query({ date })}`),
  more: (date?: string) =>
    request<BatchResponse>(`/api/batch/today/more${query({ date })}`, {
      method: "POST",
    }),
  skip: (id: number, date?: string) =>
    request<{ ok: boolean }>(`/api/files/${id}/skip`, {
      method: "POST",
      body: JSON.stringify({ date }),
    }),

  files: (params: {
    q?: string;
    tagged?: boolean;
    untagged?: boolean;
    key?: string;
    value?: string;
    cursor?: number;
    limit?: number;
    sort?: string;
  }) =>
    request<{ files: FileSummary[]; cursor: number | null }>(
      `/api/files${query(params)}`,
    ),
  file: (id: number) => request<FileDetail>(`/api/files/${id}`),
  save: (id: number, tags: Tag[], description: string, date?: string) =>
    request<FileDetail & { undoId: number; metadataWritable: boolean }>(
      `/api/files/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ tags, description, date }),
      },
    ),
  undo: (undoId: number, date?: string) =>
    request<FileDetail>(`/api/undo/${undoId}`, {
      method: "POST",
      body: JSON.stringify({ date }),
    }),
  rejectSuggestion: (
    fileId: number,
    suggestion: { key: string; value: string },
    date?: string,
  ) =>
    request<{ ok: boolean }>("/api/suggestions/reject", {
      method: "POST",
      body: JSON.stringify({
        fileId,
        key: suggestion.key,
        value: suggestion.value,
        date,
      }),
    }),

  tags: () =>
    request<{
      keys: { key: string; multiValue: boolean; count: number }[];
      values: { key: string; value: string; count: number }[];
    }>("/api/tags"),

  renameTag: (key: string, from: string, to: string) =>
    request<{ updated: number }>("/api/tags/rename", {
      method: "POST",
      body: JSON.stringify({ key, from, to }),
    }),
  removeTag: (key: string, value: string) =>
    request<{ updated: number }>("/api/tags/remove", {
      method: "POST",
      body: JSON.stringify({ key, value }),
    }),
  setKey: (key: string, multiValue: boolean) =>
    request<{ ok: boolean }>("/api/tags/keys", {
      method: "POST",
      body: JSON.stringify({ key, multiValue }),
    }),

  stats: () => request<StatsResponse>("/api/stats"),

  migration: () =>
    request<{ state: MigrationState; rows: MigrationTagRow[] }>(
      "/api/migration",
    ),
  scanMigration: () =>
    request<{ state: MigrationState; rows: MigrationTagRow[] }>(
      "/api/migration/scan",
      { method: "POST" },
    ),
  mapMigration: (
    mappings: {
      legacyValue: string;
      key: string;
      value: string;
      action: "map" | "skip";
    }[],
  ) =>
    request<{ state: MigrationState; rows: MigrationTagRow[] }>(
      "/api/migration/map",
      {
        method: "POST",
        body: JSON.stringify({ mappings }),
      },
    ),
  applyMigration: (stripFilenames: boolean) =>
    request<{
      started: boolean;
      state: MigrationState;
      rows: MigrationTagRow[];
    }>("/api/migration/apply", {
      method: "POST",
      body: JSON.stringify({ stripFilenames }),
    }),

  people: () =>
    request<{
      people: { name: string; count: number; faceId: number; fileId: number }[];
    }>("/api/faces/people"),
  clusters: () =>
    request<{
      clusters: {
        id: number;
        size: number;
        faceIds: number[];
        representativeFaceId: number | null;
        representativeFileId: number | null;
        faces: { faceId: number; fileId: number; path: string; name: string }[];
      }[];
    }>("/api/faces/clusters"),
  labelFace: (faceId: number, person: string) =>
    request<{ ok: boolean; fileId: number }>(`/api/faces/${faceId}/label`, {
      method: "POST",
      body: JSON.stringify({ person }),
    }),
  unlabelFace: (faceId: number) =>
    request<{ ok: boolean }>(`/api/faces/${faceId}/unlabel`, {
      method: "POST",
    }),
  labelCluster: (faceIds: number[], person: string) =>
    request<{ updated: number }>("/api/faces/clusters/label", {
      method: "POST",
      body: JSON.stringify({ faceIds, person }),
    }),
  processFaces: (fileId: number) =>
    request<{ faces: FileDetail["faces"]; available: boolean }>(
      `/api/files/${fileId}/faces/process`,
      { method: "POST" },
    ),

  pushKey: () => request<{ publicKey: string }>("/api/push/key"),
  subscribePush: (subscription: PushSubscriptionJSON) =>
    request<{ ok: boolean }>("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify(subscription),
    }),
  unsubscribePush: (endpoint: string) =>
    request<{ ok: boolean }>("/api/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    }),
  testPush: () =>
    request<{ sent: number }>("/api/push/test", { method: "POST" }),
};

export type {
  BatchResponse,
  FileDetail,
  FileSummary,
  SettingsResponse,
  StatsResponse,
  StatusResponse,
  Tag,
  TagSuggestion,
};
