import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ScanFace, UserRound, Users } from "lucide-react";
import { api } from "../api";

export default function PeoplePage() {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });
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
        ) : clusters.data?.clusters.length ? (
          <div className="space-y-3">
            {clusters.data.clusters.map((cluster) => (
              <ClusterCard
                key={cluster.id}
                cluster={cluster}
                onNamed={() => {
                  client.invalidateQueries({ queryKey: ["clusters"] });
                  client.invalidateQueries({ queryKey: ["people"] });
                  client.invalidateQueries({ queryKey: ["status"] });
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
  onNamed,
}: {
  cluster: {
    id: number;
    size: number;
    faceIds: number[];
    representativeFileId: number | null;
    faces: { fileId: number; name: string }[];
  };
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
              key={face.fileId}
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
          placeholder="Who is this?"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <button
          className="btn btn-primary"
          type="submit"
          disabled={!name.trim() || label.isPending}
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
