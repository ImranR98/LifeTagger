import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Check,
  ChevronDown,
  Loader2,
  SkipForward,
  Sparkles,
  Undo2,
} from "lucide-react";
import type { Tag } from "@shared/types";
import { valueNorm } from "@shared/tag-format";
import { api } from "../api";
import { MediaViewer } from "../components/MediaViewer";
import { TagEditor } from "../components/TagEditor";

export default function TodayPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const batch = useQuery({
    queryKey: ["batch"],
    queryFn: () => api.batch(),
    refetchInterval: (query) => (query.state.data?.facesPending ? 5000 : false),
  });
  const tagsQuery = useQuery({ queryKey: ["tags"], queryFn: api.tags });
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.stats });
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: (query) =>
      query.state.data?.indexing.running ? 2500 : false,
  });
  const [tags, setTags] = useState<Tag[]>([]);
  const [description, setDescription] = useState("");
  const [revision, setRevision] = useState<number | undefined>(undefined);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [undoId, setUndoId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const taskBusy = Boolean(
    status.data?.task?.running && status.data.task.kind !== "face-scan",
  );
  const item = batch.data?.items[0];
  const suggestions = (item?.suggestions ?? []).filter(
    (suggestion) => !rejected.has(`${suggestion.key}\u0000${suggestion.value}`),
  );

  useEffect(() => {
    if (!item) {
      setTags([]);
      setDescription("");
      return;
    }
    setTags(item.tags);
    setDescription(item.description);
    setRejected(new Set());
    setError(null);
  }, [item?.id, item?.tags.length, item?.description]);

  useEffect(() => {
    setRevision(item?.tagsRevision);
  }, [item?.id, item?.tagsRevision]);

  const save = useMutation({
    mutationFn: () =>
      api.save(item!.id, tags, description, batch.data?.date, revision),
    onSuccess: (result) => {
      setError(null);
      setUndoId(result.undoId);
      setRevision(result.tagsRevision);
      if (item?.id === result.id) {
        setTags(result.tags);
        setDescription(result.description);
      }
      setNotice(
        result.metadataWritable
          ? null
          : "Saved in LifeTagger only — this file type did not accept metadata.",
      );
      client.invalidateQueries({ queryKey: ["batch"] });
      client.invalidateQueries({ queryKey: ["tags"] });
      client.invalidateQueries({ queryKey: ["stats"] });
      client.invalidateQueries({ queryKey: ["files"] });
      client.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error ? mutationError.message : "Save failed",
      ),
  });

  const skip = useMutation({
    mutationFn: () => api.skip(item!.id, batch.data?.date),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["batch"] });
      client.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error ? mutationError.message : "Skip failed",
      ),
  });

  const undo = useMutation({
    mutationFn: () => api.undo(undoId!, batch.data?.date),
    onSuccess: (result) => {
      setError(null);
      setUndoId(null);
      setNotice("Change undone.");
      if (item?.id === result.id) {
        setTags(result.tags);
        setDescription(result.description);
      }
      setRevision(result.tagsRevision);
      client.invalidateQueries({ queryKey: ["batch"] });
      client.invalidateQueries({ queryKey: ["tags"] });
      client.invalidateQueries({ queryKey: ["stats"] });
      client.invalidateQueries({ queryKey: ["files"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error ? mutationError.message : "Undo failed",
      ),
  });

  const more = useMutation({
    mutationFn: () => api.more(batch.data?.date),
    onSuccess: () => client.invalidateQueries({ queryKey: ["batch"] }),
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not find more files",
      ),
  });

  const toggleAutoReview = useMutation({
    mutationFn: (enabled: boolean) =>
      api.updateSettings({ reviewAutoTagged: enabled }),
    onSuccess: () => {
      setError(null);
      client.invalidateQueries({ queryKey: ["batch"] });
      client.invalidateQueries({ queryKey: ["status"] });
      client.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not update auto-tag review",
      ),
  });

  const confirmTag = useMutation({
    mutationFn: (tag: Tag) => api.confirmTag(item!.id, tag.key, tag.value),
    onSuccess: (result, tag) => {
      if (result.tagsRevision !== null) setRevision(result.tagsRevision);
      setTags((current) =>
        current.map((entry) =>
          entry.key === tag.key &&
          valueNorm(entry.value) === valueNorm(tag.value)
            ? { ...entry, source: "review" }
            : entry,
        ),
      );
      client.invalidateQueries({ queryKey: ["batch"] });
      client.invalidateQueries({ queryKey: ["tags"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not confirm the tag",
      ),
  });

  if (batch.isLoading) {
    return <div className="skeleton h-96 rounded-3xl" />;
  }

  if (batch.isError) {
    return (
      <div className="card p-6">
        <h2 className="text-lg font-semibold">Could not load today’s batch</h2>
        <p className="mt-2 text-sm text-slate-400">
          {batch.error instanceof Error ? batch.error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  const data = batch.data!;
  const progress = data.total ? Math.round((data.done / data.total) * 100) : 0;
  const reviewAuto = status.data?.reviewAutoTagged ?? true;
  const autoOnly =
    Boolean(item?.tags.length) &&
    Boolean(
      item?.tags.every(
        (tag) => tag.source === "face-auto" || tag.source === "place-auto",
      ),
    );

  if (!item) {
    if (status.data?.indexing.running) {
      const indexing = status.data.indexing;
      return (
        <div className="card p-6 text-center">
          <Loader2 className="mx-auto animate-spin text-teal-300" size={30} />
          <h1 className="mt-4 text-2xl font-bold tracking-tight">
            Indexing your library
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
            {indexing.scanned.toLocaleString()} of{" "}
            {indexing.total.toLocaleString()} files checked ·{" "}
            {indexing.indexed.toLocaleString()} indexed
          </p>
          <div
            className="progress-track mx-auto mt-4 max-w-sm"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={indexing.total}
            aria-valuenow={indexing.scanned}
          >
            <div
              className="progress-fill"
              style={{
                width: `${indexing.total ? Math.round((indexing.scanned / indexing.total) * 100) : 10}%`,
              }}
            />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            You can leave this page open; the first pass only reads metadata
            once.
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <div className="card overflow-hidden p-6 text-center">
          <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-teal-300/10 text-teal-300">
            <Sparkles size={30} />
          </div>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">
            {status.data?.counts.files === 0
              ? "No media files found"
              : data.total > 0
                ? "Batch complete"
                : "All caught up"}
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">
            {status.data?.counts.files === 0
              ? "Check the media folder in Settings, then rescan. LifeTagger only indexes known photo and video extensions."
              : data.total > 0
                ? `${data.done} of ${data.total} photos handled. Your streak is ${stats.data?.streak ?? 0} day${(stats.data?.streak ?? 0) === 1 ? "" : "s"}.`
                : "There are no untagged files waiting right now. New imports will show up here after indexing."}
          </p>
          <label className="mt-4 flex flex-wrap items-center justify-center gap-2 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={reviewAuto}
              disabled={toggleAutoReview.isPending}
              onChange={(event) =>
                toggleAutoReview.mutate(event.target.checked)
              }
            />
            Review auto-tagged items
            {status.data?.counts.autoOnly ? (
              <span className="pill">
                {status.data.counts.autoOnly} auto-only
              </span>
            ) : null}
          </label>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <button
              className="btn btn-primary"
              onClick={() => more.mutate()}
              disabled={more.isPending}
            >
              {more.isPending ? (
                <Loader2 className="animate-spin" size={16} />
              ) : (
                <Sparkles size={16} />
              )}
              Review more
            </button>
            <a className="btn" href="/library">
              Open library
            </a>
          </div>
          {doneLine(stats.data?.last30Days)}
        </div>
        <button
          className="btn w-full"
          onClick={() => more.mutate()}
          disabled={more.isPending}
        >
          Find more untagged files
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-teal-300">
            Today
          </p>
          <h1 className="text-2xl font-bold tracking-tight">
            One photo at a time
          </h1>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold">
            {data.done}/{data.total}
          </div>
          <div className="text-[11px] text-slate-500">goal {data.goal}</div>
        </div>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={data.total}
        aria-valuenow={data.done}
      >
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>

      <label className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <input
          type="checkbox"
          checked={reviewAuto}
          disabled={toggleAutoReview.isPending}
          onChange={(event) => toggleAutoReview.mutate(event.target.checked)}
        />
        Review auto-tagged items
        {status.data?.counts.autoOnly ? (
          <span className="pill">{status.data.counts.autoOnly} auto-only</span>
        ) : null}
      </label>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
        <div className="space-y-3">
          <MediaViewer
            file={item}
            faces={item.faces}
            onFaceClick={() => navigate(`/file/${item.id}`)}
          />
          {autoOnly && (
            <div className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-xs text-amber-100">
              These tags were generated automatically. Saving confirms them as
              manual tags.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span className="pill">
              {item.kind === "video" ? "Video" : "Photo"}
            </span>
            {item.captureAt && (
              <span className="pill">
                {item.captureAt.replace("T", " ").slice(0, 16)}
              </span>
            )}
            {item.folder && <span className="pill">{item.folder}</span>}
            {item.gps && (
              <span className="pill">
                {item.gps.lat.toFixed(3)}, {item.gps.lon.toFixed(3)}
              </span>
            )}
            <span className="truncate">{item.name}</span>
          </div>
          {data.facesPending > 0 && (
            <p className="flex items-center gap-2 text-xs text-slate-500">
              <Loader2 size={13} className="animate-spin" /> Checking faces in
              the background; people suggestions will appear shortly.
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="card p-4">
            <TagEditor
              tags={tags}
              suggestions={suggestions}
              keys={tagsQuery.data?.keys.map((entry) => entry.key)}
              values={tagsQuery.data?.values}
              onChange={setTags}
              onConfirmTag={(tag) => confirmTag.mutate(tag)}
              onSuggested={(suggestion) => {
                setRejected((current) =>
                  new Set(current).add(
                    `${suggestion.key}\u0000${suggestion.value}`,
                  ),
                );
              }}
              onRejectSuggestion={(suggestion) => {
                setRejected((current) =>
                  new Set(current).add(
                    `${suggestion.key}\u0000${suggestion.value}`,
                  ),
                );
                api
                  .rejectSuggestion(item.id, suggestion, data.date)
                  .catch(() => undefined);
              }}
              disabled={save.isPending || taskBusy}
            />
          </div>

          <details className="card p-4" open={description.length > 0}>
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold">
              Description <ChevronDown size={16} className="text-slate-500" />
            </summary>
            <textarea
              className="textarea mt-3"
              aria-label="Description"
              placeholder="Optional context, story, or notes…"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </details>

          {error && (
            <div
              role="alert"
              className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-200"
            >
              {error}
            </div>
          )}
          {notice && (
            <div
              role="status"
              className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100"
            >
              {notice}
            </div>
          )}

          <div className="sticky bottom-[calc(78px+env(safe-area-inset-bottom))] z-20 grid grid-cols-[auto_1fr] gap-2 rounded-2xl border border-slate-800 bg-[#0b0f14]/90 p-2 backdrop-blur lg:bottom-4">
            <button
              className="btn"
              onClick={() => skip.mutate()}
              disabled={skip.isPending || save.isPending || taskBusy}
              aria-label="Skip this file"
            >
              <SkipForward size={17} />
            </button>
            <button
              className="btn btn-primary btn-lg"
              onClick={() => save.mutate()}
              disabled={
                save.isPending ||
                skip.isPending ||
                taskBusy ||
                tags.length === 0
              }
            >
              {save.isPending ? (
                <Loader2 className="animate-spin" size={18} />
              ) : (
                <Check size={18} />
              )}
              Save & next
            </button>
          </div>
        </div>
      </div>

      {undoId && (
        <div className="toast">
          <span className="text-sm">Saved.</span>
          <button
            className="btn btn-ghost px-3 py-1.5 text-sm text-teal-300"
            onClick={() => undo.mutate()}
            disabled={taskBusy}
          >
            <Undo2 size={14} /> Undo
          </button>
        </div>
      )}
    </div>
  );
}

function doneLine(activity?: { date: string; done: number }[]) {
  if (!activity?.length) return null;
  const total = activity.reduce((sum, day) => sum + day.done, 0);
  return (
    <p className="mt-4 text-xs text-slate-500">
      {total} photos handled in the last 30 days.
    </p>
  );
}
