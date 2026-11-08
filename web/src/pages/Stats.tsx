import { useQuery } from "@tanstack/react-query";
import { Flame, Image, Sparkles, Tag, UserCheck } from "lucide-react";
import { api } from "../api";

function dayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export default function StatsPage() {
  const stats = useQuery({ queryKey: ["stats"], queryFn: api.stats });
  if (stats.isLoading) return <div className="skeleton h-96 rounded-3xl" />;
  if (!stats.data) return <div className="card p-6">Stats unavailable.</div>;
  const data = stats.data;
  const activity = new Map(data.last30Days.map((day) => [day.date, day.done]));
  const days = Array.from({ length: 28 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - (27 - index));
    return { date: dayKey(date), done: activity.get(dayKey(date)) ?? 0 };
  });
  const max = Math.max(1, ...days.map((day) => day.done));
  const total30 = data.last30Days.reduce((sum, day) => sum + day.done, 0);

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-teal-300">
          Stats
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          The habit, visible
        </h1>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard
          icon={Flame}
          label="Current streak"
          value={`${data.streak} day${data.streak === 1 ? "" : "s"}`}
          accent
        />
        <StatCard
          icon={Sparkles}
          label="Tagged files"
          value={String(data.totalTagged)}
        />
        <StatCard
          icon={UserCheck}
          label="Manually tagged"
          value={String(data.totalManuallyTagged)}
        />
        <StatCard
          icon={Image}
          label="Indexed files"
          value={String(data.indexedFiles)}
        />
        <StatCard
          icon={Tag}
          label="Waiting today"
          value={String(data.pendingBatches)}
        />
      </div>

      <div className="card p-5">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-sm font-semibold">Last 28 days</h2>
            <p className="text-xs text-slate-500">
              {total30} photos handled · longest streak {data.longestStreak}
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-7 gap-1.5">
          {days.map((day) => (
            <div
              key={day.date}
              title={`${day.date}: ${day.done} tagged`}
              className="aspect-square rounded-md border border-slate-800"
              style={{
                background:
                  day.done === 0
                    ? "rgba(255,255,255,0.025)"
                    : `rgba(94, 234, 212, ${0.18 + (day.done / max) * 0.72})`,
              }}
            />
          ))}
        </div>
        <div className="mt-2 flex justify-between text-[10px] text-slate-600">
          <span>4 weeks ago</span>
          <span>Today</span>
        </div>
      </div>

      <div className="card p-5">
        <h2 className="text-sm font-semibold">Most-used keys</h2>
        {data.topKeys.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            Tag a few files to see your vocabulary grow.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {data.topKeys.map((key) => {
              const maxKey = data.topKeys[0]?.count ?? 1;
              return (
                <div key={key.key} className="flex items-center gap-3">
                  <span className="w-24 truncate text-xs text-slate-400">
                    {key.key}
                  </span>
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-teal-300/70"
                      style={{
                        width: `${Math.max(8, (key.count / maxKey) * 100)}%`,
                      }}
                    />
                  </div>
                  <span className="w-10 text-right text-xs text-slate-500">
                    {key.count}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: typeof Flame;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`card p-4 ${accent ? "border-teal-300/25 bg-teal-300/5" : ""}`}
    >
      <Icon size={17} className={accent ? "text-teal-300" : "text-slate-500"} />
      <div className="mt-3 text-2xl font-bold tracking-tight">{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}
