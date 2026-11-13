import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ScanFace, UserRound, Users } from "lucide-react";
import { api } from "../api";

export default function PeoplePage() {
  const client = useQueryClient();
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
  const busy =
    Boolean(status.data?.task?.running) ||
    Boolean(status.data?.indexing.running);
  const people = useQuery({
    queryKey: ["people"],
    queryFn: api.people,
    enabled: status.data?.facesEnabled !== false,
  });
  const clusters = useQuery({
    queryKey: ["clusters"],
    queryFn: api.clusters,
    enabled: status.data?.facesEnabled !== false,
  });

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-teal-300">
          People
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          Faces become names
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-400">
          Name someone once and LifeTagger will suggest them in future photos.
          Everything stays on this server.
        </p>
      </div>

      {!status.data?.facesEnabled && (
        <div className="card p-5 text-sm text-slate-400">
          Face recognition is turned off. Enable it in Settings, then run face
          detection on photos you review.
        </div>
      )}

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-300">
          <Users size={16} className="text-teal-300" /> Known people
        </h2>
        {people.isLoading ? (
          <div className="skeleton h-24 rounded-2xl" />
        ) : people.isError ? (
          <div className="card p-5 text-sm text-slate-400">
            <p>Known people could not be loaded.</p>
            <button className="btn mt-3" onClick={() => people.refetch()}>
              Try again
            </button>
          </div>
        ) : people.data?.people.length ? (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {people.data.people.map((person) => (
              <Link
                key={person.name}
                to={`/file/${person.fileId}`}
                className="card flex items-center gap-3 p-3"
              >
                <span className="grid h-10 w-10 place-items-center rounded-full bg-teal-300/10 text-teal-300">
                  <UserRound size={19} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">
                    {person.name}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {person.count} item{person.count === 1 ? "" : "s"}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="card p-5 text-sm text-slate-400">
            No named faces yet. Open a photo, press “Detect faces”, and name the
            people you see.
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-300">
          <ScanFace size={16} className="text-teal-300" /> Unknown clusters
        </h2>
        {clusters.isLoading ? (
          <div className="skeleton h-36 rounded-2xl" />
        ) : clusters.isError ? (
          <div className="card p-5 text-sm text-slate-400">
            <p>Unknown clusters could not be loaded.</p>
            <button className="btn mt-3" onClick={() => clusters.refetch()}>
              Try again
            </button>
          </div>
        ) : clusters.data?.clusters.length ? (
          <div className="space-y-3">
            {clusters.data.clusters.map((cluster) => (
              <ClusterCard
                key={cluster.faces[0]?.faceId ?? cluster.id}
                cluster={cluster}
                disabled={busy}
                onNamed={() => {
                  client.invalidateQueries({ queryKey: ["clusters"] });
                  client.invalidateQueries({ queryKey: ["people"] });
                  client.invalidateQueries({ queryKey: ["status"] });
                  client.invalidateQueries({ queryKey: ["tags"] });
                  client.invalidateQueries({ queryKey: ["files"] });
                  client.invalidateQueries({ queryKey: ["batch"] });
                  client.invalidateQueries({ queryKey: ["stats"] });
                }}
              />
            ))}
          </div>
        ) : (
          <div className="card p-5 text-sm text-slate-400">
            No recurring unknown faces yet. Clusters appear after several photos
            have been scanned.
          </div>
        )}
      </section>
    </div>
  );
}

function ClusterCard({
  cluster,
  disabled,
  onNamed,
}: {
  cluster: {
    id: number;
    size: number;
    faceIds: number[];
    representativeFileId: number | null;
    faces: { faceId: number; fileId: number; name: string }[];
  };
  disabled?: boolean;
  onNamed: () => void;
}) {
  const [name, setName] = useState("");
  const label = useMutation({
    mutationFn: () => api.labelCluster(cluster.faceIds, name.trim()),
    onSuccess: () => {
      setName("");
      onNamed();
    },
  });
  return (
    <div className="card p-4">
      <div className="flex items-center gap-3">
        <div className="flex -space-x-2">
          {cluster.faces.slice(0, 5).map((face) => (
            <img
              key={face.faceId}
              src={`/api/files/${face.fileId}/thumb`}
              alt=""
              className="h-10 w-10 rounded-full border-2 border-[#121923] object-cover"
              loading="lazy"
            />
          ))}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold">
            {cluster.size} matching faces
          </div>
          <div className="truncate text-xs text-slate-500">
            Probably the same person
          </div>
        </div>
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) label.mutate();
        }}
      >
        <input
          className="input"
          aria-label="Name this person"
          placeholder="Who is this?"
          value={name}
          disabled={disabled}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="btn btn-primary"
          type="submit"
          disabled={!name.trim() || label.isPending || disabled}
        >
          {label.isPending ? (
            <Loader2 size={15} className="animate-spin" />
          ) : (
            <UserRound size={15} />
          )}
          Name
        </button>
      </form>
      {label.isError && (
        <p className="mt-2 text-xs text-rose-300">
          {label.error instanceof Error
            ? label.error.message
            : "Could not name cluster"}
        </p>
      )}
    </div>
  );
}
