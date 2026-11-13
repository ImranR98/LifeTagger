import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Upload,
} from "lucide-react";
import type { MigrationTagRow } from "@shared/types";
import { api } from "../api";

type Draft = { key: string; value: string; action: "map" | "skip" };

export default function MigrationPage() {
  const client = useQueryClient();
  const migration = useQuery({
    queryKey: ["migration"],
    queryFn: api.migration,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      if (state?.running) return 1200;
      if (state?.needsScan) return 5000;
      return false;
    },
  });
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.task?.running) return 1500;
      if (data?.indexing.running) return 2500;
      return false;
    },
  });
  const statusReady = status.data !== undefined;
  const indexing = status.data?.indexing.running ?? false;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [bulkKey, setBulkKey] = useState("");
  const [strip, setStrip] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const autoScanStarted = useRef(false);

  function exportMapping() {
    const payload = Object.entries(drafts).map(([legacyValue, draft]) => ({
      legacyValue,
      ...draft,
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "lifetagger-mapping.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importMapping(file: File) {
    try {
      const payload = JSON.parse(await file.text()) as unknown;
      if (!Array.isArray(payload)) throw new Error("not an array");
      const next: Record<string, Draft> = {};
      for (const raw of payload) {
        if (!raw || typeof raw !== "object") throw new Error("invalid row");
        const entry = raw as Record<string, unknown>;
        if (typeof entry.legacyValue !== "string" || !entry.legacyValue)
          continue;
        if (entry.key !== undefined && typeof entry.key !== "string")
          throw new Error("invalid key");
        if (entry.value !== undefined && typeof entry.value !== "string")
          throw new Error("invalid value");
        next[entry.legacyValue] = {
          key: entry.key ?? "",
          value: entry.value ?? entry.legacyValue,
          action: entry.action === "skip" ? "skip" : "map",
        };
      }
      setDrafts(next);
      setMessage("Mapping file loaded. Review it, then press Save mapping.");
      setError(null);
    } catch {
      setError("That file is not a valid LifeTagger mapping JSON.");
    }
  }

  useEffect(() => {
    if (!migration.data?.rows) return;
    setDrafts((current) => {
      const next: Record<string, Draft> = { ...current };
      for (const row of migration.data.rows) {
        if (next[row.legacyValue]) continue;
        const mapped = row.mapped[0];
        next[row.legacyValue] = mapped
          ? { key: mapped.key, value: mapped.value, action: mapped.action }
          : { key: "", value: row.legacyValue, action: "map" };
      }
      return next;
    });
  }, [migration.data?.rows]);

  const scan = useMutation({
    mutationFn: api.scanMigration,
    onSuccess: (result) => {
      if (!result.started) {
        setError(result.reason ?? "Could not start the migration scan");
        return;
      }
      setError(null);
      setMessage(
        result.state.running
          ? "Scanning the library for legacy tags…"
          : "Scan complete.",
      );
      client.invalidateQueries({ queryKey: ["migration"] });
      client.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error ? mutationError.message : "Scan failed",
      ),
  });

  const wasTaskRunning = useRef(false);
  useEffect(() => {
    if (wasTaskRunning.current && !status.data?.task?.running) {
      autoScanStarted.current = false;
    }
    wasTaskRunning.current = Boolean(status.data?.task?.running);
  }, [status.data?.task?.running]);

  useEffect(() => {
    const state = migration.data?.state;
    if (
      !autoScanStarted.current &&
      state &&
      statusReady &&
      (!state.scanned || state.needsScan) &&
      !state.running &&
      !state.errors &&
      !indexing &&
      !status.data?.task?.running &&
      !scan.isPending
    ) {
      autoScanStarted.current = true;
      scan.mutate();
    }
  }, [
    migration.data,
    scan.isPending,
    indexing,
    statusReady,
    status.data?.task?.running,
  ]);

  function mappingsFromDrafts() {
    const current = new Set(
      (migration.data?.rows ?? []).map((row) => row.legacyValue),
    );
    return Object.entries(drafts)
      .filter(([legacyValue]) => current.has(legacyValue))
      .map(([legacyValue, draft]) => ({ legacyValue, ...draft }))
      .filter((mapping) => mapping.action === "skip" || mapping.key.trim());
  }

  const save = useMutation({
    mutationFn: () => api.mapMigration(mappingsFromDrafts()),
    onSuccess: () => {
      setMessage("Mapping saved.");
      setError(null);
      client.invalidateQueries({ queryKey: ["migration"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not save mapping",
      ),
  });

  const apply = useMutation({
    mutationFn: async () => {
      const currentRows = migration.data?.rows ?? [];
      const missing = currentRows.filter((row) => {
        const draft = drafts[row.legacyValue];
        return !draft || (draft.action === "map" && !draft.key.trim());
      });
      if (missing.length > 0) {
        throw new Error(
          `${missing.length} legacy ${missing.length === 1 ? "string still needs" : "strings still need"} a key (or mark it Skip).`,
        );
      }
      // Apply works on the server-side mapping, so persist the table as it is
      // right now instead of relying on the user pressing Save first.
      await api.mapMigration(mappingsFromDrafts());
      const result = await api.applyMigration(strip);
      if (!result.started)
        throw new Error(result.reason ?? "Could not start the migration");
      return result;
    },
    onSuccess: () => {
      setError(null);
      setMessage(
        "Migration started. This can take a while for a large library.",
      );
      client.invalidateQueries({ queryKey: ["migration"] });
      client.invalidateQueries({ queryKey: ["status"] });
      client.invalidateQueries({ queryKey: ["files"] });
      client.invalidateQueries({ queryKey: ["batch"] });
      client.invalidateQueries({ queryKey: ["tags"] });
      client.invalidateQueries({ queryKey: ["stats"] });
      client.invalidateQueries({ queryKey: ["people"] });
      client.invalidateQueries({ queryKey: ["review"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not start migration",
      ),
  });

  const state = migration.data?.state;
  const rows = migration.data?.rows ?? [];
  const mappedCount = rows.filter(
    (row) =>
      drafts[row.legacyValue]?.action === "skip" ||
      Boolean(drafts[row.legacyValue]?.key.trim()),
  ).length;
  const missingCount = rows.filter((row) => {
    const draft = drafts[row.legacyValue];
    return !draft || (draft.action === "map" && !draft.key.trim());
  }).length;
  const progress = state?.total
    ? Math.round((state.processed / state.total) * 100)
    : 0;
  const busy =
    Boolean(state?.running) ||
    !statusReady ||
    indexing ||
    Boolean(status.data?.task?.running) ||
    scan.isPending ||
    apply.isPending ||
    save.isPending;
  const needsRefresh = Boolean(state?.needsScan) && !state?.running;
  const scanning = state?.mode === "scan" || scan.isPending;
  const applying = state?.mode === "apply" || apply.isPending;
  const indexingProgress = status.data?.indexing;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-teal-300">
            Migration
          </p>
          <h1 className="text-2xl font-bold tracking-tight">
            Old tags, mapped properly
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Legacy tags are plain strings. Decide what each one becomes — you
            can change the key and the value. Nothing is applied until you press
            the button.
          </p>
        </div>
        <Link to="/settings" className="btn">
          Settings
        </Link>
      </div>

      {indexing && (
        <div className="rounded-2xl border border-sky-300/30 bg-sky-300/10 p-3 text-sm text-sky-100">
          <div className="flex items-center gap-2">
            <Loader2 size={16} className="shrink-0 animate-spin" />
            <span className="flex-1 font-semibold">
              Indexing your library before migration can continue
            </span>
            <span className="tabular-nums text-xs text-sky-200">
              {indexingProgress?.scanned.toLocaleString() ?? 0}
              {indexingProgress?.total
                ? ` / ${indexingProgress.total.toLocaleString()}`
                : ""}
            </span>
          </div>
          <p className="mt-1 text-xs text-sky-200/80">
            Scanning and applying legacy tags are disabled until indexing
            finishes so the migration inventory cannot be built from a
            half-indexed library.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Metric label="Legacy files" value={state?.legacyFiles ?? "—"} />
        <Metric label="Unique strings" value={state?.legacyTags ?? "—"} />
        <Metric label="Mapped" value={mappedCount} />
        <Metric label="Pending" value={state?.pendingFiles ?? "—"} />
        <Metric label="Applied" value={state?.appliedFiles ?? "—"} />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="btn"
          onClick={() => scan.mutate()}
          disabled={scan.isPending || busy}
        >
          {scanning ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <RefreshCw size={15} />
          )}
          {scanning
            ? "Scanning…"
            : state?.scanned
              ? "Scan again"
              : "Scan for legacy tags"}
        </button>
        <button
          className="btn"
          onClick={() => save.mutate()}
          disabled={save.isPending || rows.length === 0 || busy || needsRefresh}
        >
          {save.isPending ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Save size={15} />
          )}
          Save mapping
        </button>
        <span className="self-center text-[11px] text-slate-500">
          Apply saves the table automatically.
        </span>
        <button
          className="btn btn-primary"
          onClick={() => {
            if (
              confirm(
                `Apply the current mapping to ${state?.pendingFiles ?? 0} files${strip ? " and strip old filename suffixes" : ""}?`,
              )
            )
              apply.mutate();
          }}
          disabled={
            apply.isPending ||
            !state?.scanned ||
            state?.pendingFiles === 0 ||
            busy ||
            needsRefresh
          }
        >
          {applying ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <Play size={15} />
          )}
          {applying ? "Applying…" : "Apply migration"}
        </button>
        <label className="flex items-center gap-2 rounded-xl border border-slate-800 px-3 text-sm text-slate-400">
          <input
            type="checkbox"
            checked={strip}
            disabled={busy || needsRefresh}
            onChange={(event) => setStrip(event.target.checked)}
          />
          Strip old filename suffixes
        </label>
        {missingCount > 0 && (
          <span className="self-center text-xs text-amber-300">
            {missingCount}{" "}
            {missingCount === 1 ? "row still needs" : "rows still need"} a key
            (or Skip)
          </span>
        )}
        <button
          className="btn"
          onClick={exportMapping}
          disabled={rows.length === 0 || busy || needsRefresh}
          title="Download the mapping as JSON"
        >
          <Download size={15} /> Export
        </button>
        <button
          className="btn"
          onClick={() => fileInput.current?.click()}
          disabled={busy || needsRefresh}
          title="Load a mapping JSON file"
        >
          <Upload size={15} /> Import
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importMapping(file);
            event.target.value = "";
          }}
        />
      </div>

      {needsRefresh && (
        <div className="rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          The legacy inventory is out of date. Run Scan again before editing or
          applying the mapping.
        </div>
      )}

      {state?.running && (
        <div className="card p-4">
          <div className="mb-2 flex justify-between gap-3 text-xs text-slate-400">
            <span className="font-semibold text-slate-200">
              {state.mode === "scan"
                ? "Scanning the indexed library…"
                : "Applying metadata…"}
            </span>
            <span className="tabular-nums">
              {state.processed.toLocaleString()} /{" "}
              {state.total.toLocaleString()} · {state.errors} error
              {state.errors === 1 ? "" : "s"}
            </span>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={state.total}
            aria-valuenow={state.processed}
          >
            <div className="progress-fill" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {message && (
        <div
          role="status"
          className="rounded-xl border border-teal-300/25 bg-teal-300/10 p-3 text-sm text-teal-100"
        >
          {message}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-200"
        >
          {error}
        </div>
      )}
      {state && state.errors > 0 && !state.running && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          Migration reported {state.errors} error
          {state.errors === 1 ? "" : "s"}. Check that every legacy string above
          has a key (or is explicitly skipped), and that filenames do not
          collide.
          {state.lastError && (
            <span className="mt-1 block break-words font-mono text-[11px] text-amber-200/80">
              {state.lastError}
            </span>
          )}
        </div>
      )}

      {rows.length === 0 && state?.scanned ? (
        <div className="card p-8 text-center">
          <Check className="mx-auto text-teal-300" size={28} />
          <p className="mt-2 font-semibold">Nothing to migrate.</p>
          <p className="text-sm text-slate-500">
            No legacy filename or description tags were found.
          </p>
        </div>
      ) : rows.length === 0 ? (
        <div className="card p-8 text-center text-sm text-slate-400">
          Run the scan to find legacy tags from the old filename and description
          convention.
        </div>
      ) : (
        <>
          <div className="card flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
            <label className="flex-1">
              <span className="label">Assign a key to every row</span>
              <input
                className="input"
                aria-label="Key to apply to all rows"
                value={bulkKey}
                disabled={busy || needsRefresh}
                onChange={(event) => setBulkKey(event.target.value)}
                placeholder="e.g. place, event, people, keyword"
              />
            </label>
            <button
              className="btn"
              disabled={!bulkKey.trim() || busy || needsRefresh}
              onClick={() => {
                const key = bulkKey.trim();
                setDrafts((current) => {
                  const next = { ...current };
                  for (const row of rows) {
                    if (next[row.legacyValue]?.action === "skip") continue;
                    next[row.legacyValue] = {
                      ...(next[row.legacyValue] ?? { value: row.legacyValue }),
                      key,
                      action: "map",
                    };
                  }
                  return next;
                });
              }}
            >
              Apply key to all
            </button>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Legacy string</th>
                  <th>Uses</th>
                  <th>Key</th>
                  <th>Value</th>
                  <th>Skip</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <MappingRow
                    key={row.legacyValue}
                    row={row}
                    draft={
                      drafts[row.legacyValue] ?? {
                        key: "",
                        value: row.legacyValue,
                        action: "map",
                      }
                    }
                    disabled={busy || needsRefresh}
                    onChange={(draft) =>
                      setDrafts((current) => ({
                        ...current,
                        [row.legacyValue]: draft,
                      }))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function MappingRow({
  row,
  draft,
  disabled,
  onChange,
}: {
  row: MigrationTagRow;
  draft: Draft;
  disabled?: boolean;
  onChange: (draft: Draft) => void;
}) {
  const skipped = draft.action === "skip";
  return (
    <tr className={skipped ? "opacity-50" : ""}>
      <td>
        <div className="font-mono text-xs">{row.legacyValue}</div>
        <div className="mt-0.5 text-[10px] text-slate-500">
          {row.sources.join(" + ")}
        </div>
      </td>
      <td className="text-xs text-slate-400">{row.count}</td>
      <td>
        <input
          className="input min-h-8 min-w-28 py-1 text-xs"
          aria-label={`Key for ${row.legacyValue}`}
          value={draft.key}
          disabled={skipped || disabled}
          onChange={(event) =>
            onChange({ ...draft, key: event.target.value, action: "map" })
          }
          placeholder="key"
        />
      </td>
      <td>
        <input
          className="input min-h-8 min-w-36 py-1 text-xs"
          aria-label={`Value for ${row.legacyValue}`}
          value={draft.value}
          disabled={skipped || disabled}
          onChange={(event) =>
            onChange({ ...draft, value: event.target.value, action: "map" })
          }
        />
      </td>
      <td>
        <input
          type="checkbox"
          aria-label={`Skip ${row.legacyValue}`}
          checked={skipped}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...draft,
              action: event.target.checked ? "skip" : "map",
            })
          }
        />
      </td>
    </tr>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card p-3">
      <div className="text-xl font-bold">{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
