import { useDeferredValue, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Loader2, Search, SlidersHorizontal } from "lucide-react";
import { api } from "../api";

export default function LibraryPage() {
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"tagged" | "untagged" | "all">("tagged");
  const deferredSearch = useDeferredValue(search);
  const files = useInfiniteQuery({
    queryKey: ["files", deferredSearch, mode],
    queryFn: ({ pageParam }) =>
      api.files({
        q: deferredSearch || undefined,
        tagged: mode === "tagged" || undefined,
        untagged: mode === "untagged" || undefined,
        cursor: pageParam,
        limit: 60,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) =>
      last.hasMore ? (last.cursor ?? undefined) : undefined,
  });
  const rows = files.data?.pages.flatMap((page) => page.files) ?? [];

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-teal-300">
          Library
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          Everything, searchable
        </h1>
      </div>
      <div className="space-y-2">
        <label className="relative block">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
            size={17}
          />
          <input
            className="input pl-10"
            aria-label="Search the library"
            placeholder="Search names, descriptions, tags…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            inputMode="search"
          />
        </label>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <SlidersHorizontal size={14} /> Show
          </span>
          <div className="flex rounded-xl border border-slate-800 bg-slate-900/40 p-1">
            {(
              [
                ["tagged", "Tagged"],
                ["untagged", "Untagged"],
                ["all", "All"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  mode === value
                    ? "bg-teal-300 text-slate-950"
                    : "text-slate-400 hover:text-slate-100"
                }`}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {files.isLoading && (
        <div className="grid-media">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="skeleton aspect-square rounded-2xl" />
          ))}
        </div>
      )}

      {files.isError && (
        <div role="alert" className="card p-6">
          <p className="font-semibold">The library could not be loaded.</p>
          <p className="mt-1 text-sm text-slate-400">
            {files.error instanceof Error
              ? files.error.message
              : "The server did not respond."}
          </p>
          <button className="btn mt-4" onClick={() => files.refetch()}>
            Try again
          </button>
        </div>
      )}

      {!files.isLoading && !files.isError && rows.length === 0 && (
        <div className="card p-8 text-center">
          <p className="font-semibold">No files match.</p>
          <p className="mt-1 text-sm text-slate-500">
            Try a different search, or switch the filter to All.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="grid-media">
          {rows.map((file) => (
            <Link
              key={file.id}
              to={`/file/${file.id}`}
              className="thumb-card group"
            >
              <div className="relative">
                <img src={file.thumbUrl} alt={file.name} loading="lazy" />
                {file.kind === "video" && (
                  <span className="absolute left-2 top-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    VIDEO
                  </span>
                )}
                {file.legacyPending && (
                  <span className="absolute right-2 top-2 rounded-md bg-amber-300 px-1.5 py-0.5 text-[10px] font-bold text-amber-950">
                    MIGRATE
                  </span>
                )}
              </div>
              <div className="space-y-1 p-2.5">
                <div className="truncate text-xs font-semibold">
                  {file.name}
                </div>
                <div className="truncate text-[11px] text-slate-500">
                  {file.tags.length > 0
                    ? file.tags
                        .slice(0, 2)
                        .map((tag) => `${tag.key}: ${tag.value}`)
                        .join(" · ")
                    : file.localDate || "untagged"}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {files.hasNextPage && (
        <button
          className="btn w-full"
          onClick={() => files.fetchNextPage()}
          disabled={files.isFetchingNextPage}
        >
          {files.isFetchingNextPage ? (
            <Loader2 className="animate-spin" size={16} />
          ) : null}
          Load more
        </button>
      )}
    </div>
  );
}
