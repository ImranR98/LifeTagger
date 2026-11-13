import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Check,
  Loader2,
  ScanFace,
  Undo2,
  UserRound,
} from "lucide-react";
import type { Face, Tag } from "@shared/types";
import { valueNorm } from "@shared/tag-format";
import { api } from "../api";
import { MediaViewer } from "../components/MediaViewer";
import { TagEditor } from "../components/TagEditor";

export default function FileDetailPage() {
  const { id } = useParams();
  const fileId = Number(id);
  const client = useQueryClient();
  const file = useQuery({
    queryKey: ["file", fileId],
    queryFn: () => api.file(fileId),
    enabled: Number.isFinite(fileId),
  });
  const tagsQuery = useQuery({ queryKey: ["tags"], queryFn: api.tags });
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: (query) =>
      query.state.data?.task?.running ? 1500 : false,
  });
  const anyTaskBusy = Boolean(status.data?.task?.running);
  const writeTaskBusy = Boolean(
    status.data?.task?.running && status.data.task.kind !== "face-scan",
  );
  const [tags, setTags] = useState<Tag[]>([]);
  const [description, setDescription] = useState("");
  const [revision, setRevision] = useState<number | undefined>(undefined);
  const [undoId, setUndoId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (file.data) {
      setTags(file.data.tags);
      setDescription(file.data.description);
    }
  }, [file.data?.id, file.data?.tags.length, file.data?.description]);

  useEffect(() => {
    setRevision(file.data?.tagsRevision);
  }, [file.data?.id, file.data?.tagsRevision]);

  const save = useMutation({
    mutationFn: () => api.save(fileId, tags, description, undefined, revision),
    onSuccess: (result) => {
      setError(null);
      setUndoId(result.undoId);
      setTags(result.tags);
      setDescription(result.description);
      setRevision(result.tagsRevision);
      setNotice(
        result.metadataWritable
          ? "Saved to the file metadata."
          : "Saved in LifeTagger only; this format rejected metadata writes.",
      );
      client.invalidateQueries({ queryKey: ["file", fileId] });
      client.invalidateQueries({ queryKey: ["files"] });
      client.invalidateQueries({ queryKey: ["tags"] });
      client.invalidateQueries({ queryKey: ["stats"] });
      client.invalidateQueries({ queryKey: ["batch"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error ? mutationError.message : "Save failed",
      ),
  });

  const undo = useMutation({
    mutationFn: () => api.undo(undoId!),
    onSuccess: (result) => {
      setError(null);
      setUndoId(null);
      setTags(result.tags);
      setDescription(result.description);
      setRevision(result.tagsRevision);
      setNotice("Change undone.");
      client.invalidateQueries({ queryKey: ["file", fileId] });
      client.invalidateQueries({ queryKey: ["batch"] });
      client.invalidateQueries({ queryKey: ["tags"] });
      client.invalidateQueries({ queryKey: ["files"] });
      client.invalidateQueries({ queryKey: ["stats"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error ? mutationError.message : "Undo failed",
      ),
  });

  const detect = useMutation({
    mutationFn: () => api.processFaces(fileId),
    onSuccess: () => {
      setError(null);
      client.invalidateQueries({ queryKey: ["file", fileId] });
      client.invalidateQueries({ queryKey: ["people"] });
      client.invalidateQueries({ queryKey: ["clusters"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Face detection failed",
      ),
  });

  const confirmTag = useMutation({
    mutationFn: (tag: Tag) => api.confirmTag(fileId, tag.key, tag.value),
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
      client.invalidateQueries({ queryKey: ["file", fileId] });
      client.invalidateQueries({ queryKey: ["tags"] });
      client.invalidateQueries({ queryKey: ["batch"] });
      client.invalidateQueries({ queryKey: ["people"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not confirm the tag",
      ),
  });

  if (file.isLoading) return <div className="skeleton h-96 rounded-3xl" />;
  if (!file.data) {
    return (
      <div className="card p-6">
        <p className="font-semibold">File not found.</p>
        <Link className="btn mt-4" to="/library">
          <ArrowLeft size={16} /> Back to library
        </Link>
      </div>
    );
  }

  const detail = file.data;
  const availableKeys = tagsQuery.data?.keys.map((entry) => entry.key);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Link to="/library" className="btn btn-ghost px-2">
          <ArrowLeft size={18} /> Library
        </Link>
        <span className="truncate text-xs text-slate-500">{detail.path}</span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
        <div className="min-w-0 space-y-3">
          <MediaViewer
            file={detail}
            faces={detail.faces}
            onFaceClick={(face) =>
              document
                .getElementById(`face-row-${face.id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" })
            }
          />
          <div className="flex flex-wrap gap-2 text-xs text-slate-500">
            <span className="pill">
              {detail.kind === "video" ? "Video" : "Photo"}
            </span>
            {detail.captureAt && (
              <span className="pill">
                {detail.captureAt.replace("T", " ").slice(0, 16)}
              </span>
            )}
            {detail.width && detail.height && (
              <span className="pill">
                {detail.width} × {detail.height}
              </span>
            )}
            {detail.camera && <span className="pill">{detail.camera}</span>}
            {detail.gps && (
              <span className="pill">
                {detail.gps.lat.toFixed(4)}, {detail.gps.lon.toFixed(4)}
              </span>
            )}
            {!detail.metadataWritable && (
              <span className="pill text-amber-300">index-only</span>
            )}
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <ScanFace size={17} className="text-teal-300" /> People in this
                photo
              </h2>
              <button
                className="btn px-3 py-1.5 text-xs"
                onClick={() => detect.mutate()}
                disabled={detect.isPending || anyTaskBusy}
              >
                {detect.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <ScanFace size={14} />
                )}
                Detect faces
              </button>
            </div>
            {detail.faces && detail.faces.length > 0 ? (
              <div className="mt-3 space-y-2">
                {detail.faces.map((face, index) => (
                  <FaceLabel
                    key={face.id}
                    face={face}
                    index={index}
                    fileId={fileId}
                    disabled={anyTaskBusy}
                    onConfirmAuto={() => {
                      if (face.label)
                        confirmTag.mutate({
                          key: "people",
                          value: face.label,
                        });
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-500">
                {detail.kind === "video"
                  ? "Videos are checked using their poster frame."
                  : "No faces detected yet. Run detection or wait for the background scan."}
              </p>
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-3">
          <div className="card p-4">
            <TagEditor
              tags={tags}
              keys={availableKeys}
              values={tagsQuery.data?.values}
              onChange={setTags}
              onConfirmTag={(tag) => confirmTag.mutate(tag)}
              disabled={save.isPending || writeTaskBusy}
            />
          </div>
          <div className="card p-4">
            <label className="label" htmlFor="description">
              Description
            </label>
            <textarea
              id="description"
              className="textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional context or story…"
            />
          </div>

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
              className="flex items-center justify-between gap-3 rounded-xl border border-teal-300/20 bg-teal-300/10 p-3 text-sm text-teal-100"
            >
              <span>{notice}</span>
              {undoId && (
                <button
                  className="btn btn-ghost px-2 py-1 text-xs text-teal-300"
                  onClick={() => undo.mutate()}
                  disabled={writeTaskBusy}
                >
                  <Undo2 size={13} /> Undo
                </button>
              )}
            </div>
          )}

          <button
            className="btn btn-primary btn-lg w-full"
            onClick={() => save.mutate()}
            disabled={save.isPending || writeTaskBusy}
          >
            {save.isPending ? (
              <Loader2 className="animate-spin" size={18} />
            ) : (
              <Check size={18} />
            )}
            Save tags
          </button>
        </div>
      </div>
    </div>
  );
}

function FaceLabel({
  face,
  index,
  fileId,
  disabled,
  onConfirmAuto,
}: {
  face: Face;
  index: number;
  fileId: number;
  disabled?: boolean;
  onConfirmAuto?: () => void;
}) {
  const client = useQueryClient();
  const [name, setName] = useState(face.label ?? "");
  const label = useMutation({
    mutationFn: () =>
      name.trim()
        ? api.labelFace(face.id, name.trim())
        : api.unlabelFace(face.id),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["file", fileId] });
      client.invalidateQueries({ queryKey: ["people"] });
      client.invalidateQueries({ queryKey: ["tags"] });
    },
  });
  return (
    <div
      id={`face-row-${face.id}`}
      className="flex items-center gap-2 rounded-xl border border-transparent p-1 transition-colors focus-within:border-teal-300/30"
    >
      <span className="grid h-9 w-9 place-items-center rounded-full bg-slate-800 text-slate-400">
        <UserRound size={17} />
      </span>
      <span className="flex w-24 shrink-0 items-center gap-1 text-[11px] text-slate-500">
        Face {index + 1}
        {face.labelSource === "face-auto" && (
          <button
            type="button"
            className="chip-auto"
            disabled={disabled}
            title="Auto-generated. Click to confirm."
            onClick={onConfirmAuto}
          >
            AUTO
          </button>
        )}
      </span>
      <input
        className="input min-h-9 py-1.5"
        aria-label={`Name for face ${index + 1}`}
        value={name}
        disabled={disabled}
        onChange={(event) => setName(event.target.value)}
        placeholder={face.label ?? "Name this person"}
      />
      <button
        className="btn px-3 py-1.5 text-xs"
        aria-label={`Save name for face ${index + 1}`}
        onClick={() => label.mutate()}
        disabled={label.isPending || disabled}
      >
        {label.isPending ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Check size={13} />
        )}
      </button>
      {label.isError && (
        <span role="alert" className="text-xs text-rose-300">
          {label.error instanceof Error ? label.error.message : "Label failed"}
        </span>
      )}
    </div>
  );
}
