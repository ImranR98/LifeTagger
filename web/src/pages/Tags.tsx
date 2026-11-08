import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Merge, Plus, Trash2 } from "lucide-react";
import { api } from "../api";

export default function TagsPage() {
  const client = useQueryClient();
  const tags = useQuery({ queryKey: ["tags"], queryFn: api.tags });
  const [newKey, setNewKey] = useState("");
  const [multi, setMulti] = useState(false);

  const setKey = useMutation({
    mutationFn: ({ key, multiValue }: { key: string; multiValue: boolean }) =>
      api.setKey(key, multiValue),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tags"] }),
  });
  const addKey = useMutation({
    mutationFn: () => api.setKey(newKey.trim(), multi),
    onSuccess: () => {
      setNewKey("");
      client.invalidateQueries({ queryKey: ["tags"] });
    },
  });

  const valuesByKey = new Map<string, { value: string; count: number }[]>();
  for (const entry of tags.data?.values ?? []) {
    const list = valuesByKey.get(entry.key) ?? [];
    list.push({ value: entry.value, count: entry.count });
    valuesByKey.set(entry.key, list);
  }

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-teal-300">
          Tags
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          Keep the vocabulary clean
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          Merge spelling variants so suggestions get sharper. Renaming a value
          rewrites the metadata on every affected file.
        </p>
      </div>

      <div className="card flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
        <label className="flex-1">
          <span className="label">Add a key</span>
          <input
            className="input"
            value={newKey}
            onChange={(event) => setNewKey(event.target.value)}
            placeholder="e.g. camera, project, food"
          />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-400">
          <input
            type="checkbox"
            checked={multi}
            onChange={(event) => setMulti(event.target.checked)}
          />{" "}
          multi-value
        </label>
        <button
          className="btn"
          disabled={!newKey.trim() || addKey.isPending}
          onClick={() => addKey.mutate()}
        >
          <Plus size={15} /> Add key
        </button>
      </div>

      {tags.isLoading && <div className="skeleton h-64 rounded-2xl" />}

      <div className="space-y-3">
        {tags.data?.keys.map((key) => (
          <details
            key={key.key}
            className="card overflow-hidden"
            open={(valuesByKey.get(key.key)?.length ?? 0) > 0}
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4">
              <span className="flex items-center gap-2">
                <span className="font-semibold text-teal-300">{key.key}</span>
                <span className="pill">{key.count} uses</span>
                {key.multiValue && <span className="pill">list</span>}
              </span>
              <span className="text-xs text-slate-500">
                {valuesByKey.get(key.key)?.length ?? 0} values
              </span>
            </summary>
            <div className="space-y-2 border-t border-slate-800 p-4">
              {(valuesByKey.get(key.key) ?? []).map((entry) => (
                <ValueRow
                  key={entry.value}
                  tagKey={key.key}
                  value={entry.value}
                  count={entry.count}
                />
              ))}
              <label className="flex items-center gap-2 pt-1 text-xs text-slate-500">
                <input
                  type="checkbox"
                  checked={key.multiValue}
                  onChange={(event) =>
                    setKey.mutate({
                      key: key.key,
                      multiValue: event.target.checked,
                    })
                  }
                />
                Treat “{key.key}” as a multi-value list in the editor
              </label>
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function ValueRow({
  tagKey,
  value,
  count,
}: {
  tagKey: string;
  value: string;
  count: number;
}) {
  const client = useQueryClient();
  const [next, setNext] = useState(value);
  const rename = useMutation({
    mutationFn: () => api.renameTag(tagKey, value, next.trim()),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["tags"] });
      client.invalidateQueries({ queryKey: ["files"] });
      client.invalidateQueries({ queryKey: ["batch"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeTag(tagKey, value),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["tags"] });
      client.invalidateQueries({ queryKey: ["files"] });
      client.invalidateQueries({ queryKey: ["batch"] });
    },
  });
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-slate-800 p-2 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm font-medium">{value}</span>
        <span className="pill shrink-0">{count}</span>
      </div>
      <input
        className="input min-h-9 flex-1 py-1.5"
        value={next}
        onChange={(event) => setNext(event.target.value)}
      />
      <div className="flex gap-2">
        <button
          className="btn px-3 py-1.5 text-xs"
          disabled={!next.trim() || next.trim() === value || rename.isPending}
          onClick={() => rename.mutate()}
          title="Rename or merge this value"
        >
          {rename.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Merge size={13} />
          )}
          Merge
        </button>
        <button
          className="btn btn-danger px-3 py-1.5 text-xs"
          disabled={remove.isPending}
          onClick={() => {
            if (confirm(`Remove ${tagKey}=${value} from all files?`))
              remove.mutate();
          }}
          title="Remove this value from every file"
        >
          {remove.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Trash2 size={13} />
          )}
        </button>
      </div>
    </div>
  );
}
