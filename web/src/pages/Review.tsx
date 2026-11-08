import { useEffect, useMemo, useRef, useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, Loader2, MapPin, ScanFace, Sparkles, X } from "lucide-react";
import { api } from "../api";

const PAGE_SIZE = 60;

export default function ReviewPage() {
  const client = useQueryClient();
  const [kind, setKind] = useState<"all" | "face" | "place">("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counts = useQuery({
    queryKey: ["review", "counts"],
    queryFn: api.reviewCounts,
  });
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: (query) =>
      query.state.data?.task?.running ? 1500 : false,
  });
  const suggestions = useInfiniteQuery({
    queryKey: ["review", kind],
    queryFn: ({ pageParam }) =>
      api.reviewSuggestions({
        kind: kind === "all" ? undefined : kind,
        cursor: pageParam,
        limit: PAGE_SIZE,
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) =>
      last.hasMore ? (last.cursor ?? undefined) : undefined,
  });

  const rows =
    suggestions.data?.pages.flatMap((page) => page.suggestions) ?? [];
  const visibleIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const task = status.data?.task;
  const busy = Boolean(task?.running) || Boolean(status.data?.indexing.running);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !task?.running) {
      if (task?.message) setMessage(task.message);
      client.invalidateQueries({ queryKey: ["review"] });
      client.invalidateQueries({ queryKey: ["tags"] });
      client.invalidateQueries({ queryKey: ["people"] });
      client.invalidateQueries({ queryKey: ["files"] });
    }
    wasRunning.current = Boolean(task?.running);
  }, [task?.running, client]);

  function invalidateReview() {
    client.invalidateQueries({ queryKey: ["review"] });
    client.invalidateQueries({ queryKey: ["status"] });
    client.invalidateQueries({ queryKey: ["tags"] });
    client.invalidateQueries({ queryKey: ["people"] });
    client.invalidateQueries({ queryKey: ["files"] });
  }

  const runPlace = useMutation({
    mutationFn: api.runPlaceAutomation,
    onSuccess: (result) => {
      if (!result.started) {
        setError(result.reason ?? "Place automation did not start");
        return;
      }
      setError(null);
      setMessage("Place automation started.");
      invalidateReview();
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Place automation failed to start",
      ),
  });

  const runFace = useMutation({
    mutationFn: api.runFaceAutomation,
    onSuccess: (result) => {
      if (!result.started) {
        setError(result.reason ?? "Face automation did not start");
        return;
      }
      setError(null);
      setMessage("Face matching started.");
      invalidateReview();
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Face automation failed to start",
      ),
  });

  const scanFaces = useMutation({
    mutationFn: () => api.scanAllFaces(true),
    onSuccess: (result) => {
      if (!result.started) {
        setError(result.reason ?? "Face scan did not start");
        return;
      }
      setError(null);
      setMessage("Face scan started. This can take hours; you can cancel it.");
      invalidateReview();
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Face scan failed to start",
      ),
  });

  const approve = useMutation({
    mutationFn: () => api.approveReview([...selected]),
    onSuccess: (result) => {
      if (!result.started) {
        setError(result.reason ?? "Review approval did not start");
        return;
      }
      setSelected(new Set());
      setError(null);
      setMessage("Applying selected suggestions…");
      invalidateReview();
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not approve suggestions",
      ),
  });

  const reject = useMutation({
    mutationFn: () => api.rejectReview([...selected]),
    onSuccess: (result) => {
      setSelected(new Set());
      setError(null);
      setMessage(`${result.updated} suggestion(s) rejected.`);
      invalidateReview();
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not reject suggestions",
      ),
  });

  function toggle(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-teal-300">
            Review
          </p>
          <h1 className="text-2xl font-bold tracking-tight">
            Automation, with a second look
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            High-confidence matches were applied automatically. Approve or
            reject the remaining low-confidence face and place suggestions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn"
            onClick={() => runPlace.mutate()}
            disabled={busy || runPlace.isPending}
          >
            <MapPin size={15} /> Tag places
          </button>
          <button
            className="btn"
            onClick={() => runFace.mutate()}
            disabled={busy || runFace.isPending}
          >
            <ScanFace size={15} /> Match known faces
          </button>
          <button
            className="btn"
            onClick={() => {
              if (
                confirm(
                  "Scan every unprocessed file for faces? This can take hours and uses significant CPU. You can cancel it.",
                )
              )
                scanFaces.mutate();
            }}
            disabled={busy || scanFaces.isPending}
          >
            <Sparkles size={15} /> Scan all faces
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Metric label="Face suggestions" value={counts.data?.face ?? 0} />
        <Metric label="Place suggestions" value={counts.data?.place ?? 0} />
        <Metric label="All pending" value={counts.data?.total ?? 0} />
      </div>

      {task?.running && (
        <div className="card p-3 text-sm text-slate-300">
          <div className="flex items-center gap-2">
            <Loader2 size={15} className="animate-spin text-teal-300" />
            <span className="flex-1">
              {task.message ?? task.kind}
              {task.phase ? ` · ${task.phase}` : ""} · {task.processed}/
              {task.total || "…"}
              {task.errors > 0 ? ` · ${task.errors} errors` : ""}
            </span>
            {["face-scan", "face-auto", "place-auto", "review-apply"].includes(
              task.kind,
            ) && (
              <button
                className="btn px-3 py-1 text-xs"
                onClick={() => api.cancelTask().catch(() => undefined)}
              >
                Cancel
              </button>
            )}
          </div>
          {task.total > 0 && (
            <div className="progress-track mt-2 h-1">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.min(100, Math.round((task.processed / task.total) * 100))}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {message && (
        <div className="rounded-xl border border-teal-300/25 bg-teal-300/10 p-3 text-sm text-teal-100">
          {message}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-200">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-slate-800 bg-slate-900/40 p-1">
          {(
            [
              ["all", "All"],
              ["face", "Faces"],
              ["place", "Places"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                kind === value
                  ? "bg-teal-300 text-slate-950"
                  : "text-slate-400 hover:text-slate-100"
              }`}
              onClick={() => {
                setKind(value);
                setSelected(new Set());
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="btn px-3 py-1.5 text-xs"
          onClick={() =>
            setSelected(allVisibleSelected ? new Set() : new Set(visibleIds))
          }
          disabled={visibleIds.length === 0}
        >
          {allVisibleSelected ? "Clear page" : "Select page"}
        </button>
        <span className="text-xs text-slate-500">{selected.size} selected</span>
      </div>

      {suggestions.isLoading && (
        <div className="grid-media">
          {Array.from({ length: 12 }).map((_, index) => (
            <div key={index} className="skeleton aspect-square rounded-2xl" />
          ))}
        </div>
      )}

      {suggestions.isError && (
        <div className="card p-6">
          <p className="font-semibold">
            Review suggestions could not be loaded.
          </p>
          <p className="mt-1 text-sm text-slate-400">
            {suggestions.error instanceof Error
              ? suggestions.error.message
              : "The server did not respond."}
          </p>
          <button className="btn mt-4" onClick={() => suggestions.refetch()}>
            Try again
          </button>
        </div>
      )}

      {!suggestions.isLoading && !suggestions.isError && rows.length === 0 && (
        <div className="card p-8 text-center">
          <Check className="mx-auto text-teal-300" size={28} />
          <p className="mt-2 font-semibold">Nothing waiting for review.</p>
          <p className="mt-1 text-sm text-slate-500">
            Run place or face automation, or scan all faces first.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="grid-media">
          {rows.map((suggestion) => {
            const isSelected = selected.has(suggestion.id);
            return (
              <button
                key={suggestion.id}
                type="button"
                className={`thumb-card relative overflow-hidden text-left transition-all ${
                  isSelected
                    ? "ring-2 ring-teal-300 ring-offset-2 ring-offset-[#0b0f14]"
                    : "hover:border-slate-600"
                }`}
                onClick={() => toggle(suggestion.id)}
              >
                <div className="relative">
                  <img
                    src={suggestion.thumbUrl}
                    alt=""
                    loading="lazy"
                    className="block aspect-square w-full object-cover"
                    onError={(event) => {
                      const image = event.currentTarget;
                      if (image.dataset.fallback === "1") return;
                      image.dataset.fallback = "1";
                      image.src = `/api/files/${suggestion.fileId}/thumb`;
                    }}
                  />
                  <span
                    className={`absolute left-2 top-2 grid h-6 w-6 place-items-center rounded-full border ${
                      isSelected
                        ? "border-teal-300 bg-teal-300 text-slate-950"
                        : "border-white/40 bg-black/45 text-transparent"
                    }`}
                  >
                    <Check size={14} />
                  </span>
                  <span className="absolute right-2 top-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    {suggestion.kind === "face" ? "FACE" : "PLACE"}
                  </span>
                  <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/85 to-transparent px-2 pb-2 pt-8 text-xs font-semibold text-white">
                    {suggestion.kind === "face" ? (
                      <ScanFace size={13} className="shrink-0 text-teal-300" />
                    ) : (
                      <MapPin size={13} className="shrink-0 text-teal-300" />
                    )}
                    <span className="min-w-0 truncate">{suggestion.value}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-slate-300">
                      {suggestion.kind === "place" &&
                      suggestion.distanceM !== null
                        ? `${Math.round(suggestion.distanceM)}m`
                        : `${Math.round(suggestion.confidence * 100)}%`}
                    </span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {suggestions.hasNextPage && (
        <button
          className="btn w-full"
          onClick={() => suggestions.fetchNextPage()}
          disabled={suggestions.isFetchingNextPage}
        >
          {suggestions.isFetchingNextPage ? (
            <Loader2 className="animate-spin" size={16} />
          ) : null}
          Load more
        </button>
      )}

      {selected.size > 0 && (
        <div className="sticky bottom-[calc(78px+env(safe-area-inset-bottom))] z-20 flex items-center gap-2 rounded-2xl border border-slate-700 bg-[#111a25]/95 p-2 backdrop-blur lg:bottom-4">
          <span className="px-2 text-sm font-semibold">
            {selected.size} selected
          </span>
          <button
            className="btn ml-auto"
            onClick={() => reject.mutate()}
            disabled={reject.isPending || busy}
          >
            <X size={15} /> Reject
          </button>
          <button
            className="btn btn-primary"
            onClick={() => approve.mutate()}
            disabled={approve.isPending || busy}
          >
            {approve.isPending ? (
              <Loader2 className="animate-spin" size={15} />
            ) : (
              <Check size={15} />
            )}
            Approve
          </button>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-3">
      <div className="text-xl font-bold">{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
