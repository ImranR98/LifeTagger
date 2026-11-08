import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Loader2 } from "lucide-react";
import { api } from "../api";

export default function SetupPage() {
  const client = useQueryClient();
  const [mediaRoot, setMediaRoot] = useState("");
  const setup = useMutation({
    mutationFn: () => api.setup(mediaRoot.trim()),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["status"] });
      client.invalidateQueries({ queryKey: ["settings"] });
      client.invalidateQueries({ queryKey: ["batch"] });
    },
  });
  return (
    <div className="flex min-h-screen items-center justify-center p-5">
      <div className="card w-full max-w-lg p-6">
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-teal-300 text-slate-950">
          <FolderOpen size={24} />
        </div>
        <h1 className="mt-4 text-2xl font-bold tracking-tight">
          Point LifeTagger at your library
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Enter a directory on the server. In the container the media volume is
          usually mounted at <code className="text-slate-300">/media</code>.
          Tags are written into the files’ XMP metadata; filenames are never
          renamed by normal tagging.
        </p>
        <form
          className="mt-5 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (mediaRoot.trim()) setup.mutate();
          }}
        >
          <label>
            <span className="label">Media folder</span>
            <input
              className="input"
              autoFocus
              value={mediaRoot}
              onChange={(event) => setMediaRoot(event.target.value)}
              placeholder="/media"
            />
          </label>
          <button
            className="btn btn-primary btn-lg w-full"
            disabled={!mediaRoot.trim() || setup.isPending}
          >
            {setup.isPending ? (
              <Loader2 size={18} className="animate-spin" />
            ) : null}
            Start indexing
          </button>
        </form>
        {setup.isError && (
          <p className="mt-3 rounded-xl border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-200">
            {setup.error instanceof Error
              ? setup.error.message
              : "Could not use that folder."}
          </p>
        )}
        <p className="mt-4 text-xs text-slate-500">
          You can change this later in Settings. Indexing runs in the background
          and is safe to interrupt.
        </p>
      </div>
    </div>
  );
}
