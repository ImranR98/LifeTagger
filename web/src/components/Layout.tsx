import { NavLink, Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart3,
  Images,
  Library,
  Settings,
  Tags,
  Users,
  Loader2,
  Sparkles,
  ArrowRightLeft,
  ArrowRight,
  AlertTriangle,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { api } from "../api";

function taskLabel(kind: string): string {
  switch (kind) {
    case "migration-scan":
      return "Scanning legacy tags";
    case "migration-apply":
      return "Applying migration";
    case "tag-rename":
      return "Renaming tag values";
    case "tag-remove":
      return "Removing tag values";
    case "cluster-label":
      return "Naming faces";
    default:
      return "Working";
  }
}

const links = [
  { to: "/today", label: "Today", icon: Sparkles },
  { to: "/library", label: "Library", icon: Library },
  { to: "/people", label: "People", icon: Users },
  { to: "/tags", label: "Tags", icon: Tags },
  { to: "/stats", label: "Stats", icon: BarChart3 },
  { to: "/migration", label: "Migration", icon: ArrowRightLeft },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ children }: { children: ReactNode }) {
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.task?.running) return 1500;
      if (data?.indexing.running) return 2500;
      if (data?.counts.legacyPending) return 5000;
      return false;
    },
  });
  const indexing = status.data?.indexing;
  const task = status.data?.task;
  const location = useLocation();
  const legacyPending = status.data?.counts.legacyPending ?? 0;
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [location.pathname]);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link to="/today" className="mb-6 flex items-center gap-2 px-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-teal-300 text-slate-950">
            <Images size={19} strokeWidth={2.4} />
          </span>
          <span>
            <span className="block text-base font-bold tracking-tight">
              LifeTagger
            </span>
            <span className="block text-[11px] text-slate-500">
              a little every day
            </span>
          </span>
        </Link>
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
          >
            <link.icon size={18} />
            <span>{link.label}</span>
          </NavLink>
        ))}
        <div className="mt-auto px-2 text-[11px] text-slate-500">
          {status.data?.counts.tagged ?? 0} tagged ·{" "}
          {status.data?.counts.files ?? 0} indexed
        </div>
      </aside>
      <div className="with-sidebar">
        <header className="sticky top-0 z-30 border-b border-slate-800/70 bg-[#0b0f14]/80 px-4 py-3 backdrop-blur min-[900px]:hidden">
          <div className="mx-auto flex max-w-3xl items-center justify-between">
            <Link to="/today" className="flex items-center gap-2">
              <span className="grid h-8 w-8 place-items-center rounded-lg bg-teal-300 text-slate-950">
                <Images size={17} strokeWidth={2.4} />
              </span>
              <span className="font-bold tracking-tight">LifeTagger</span>
            </Link>
            {indexing?.running ? (
              <span className="flex items-center gap-1.5 text-xs text-amber-300">
                <Loader2 className="animate-spin" size={14} /> Indexing{" "}
                {indexing.scanned}/{indexing.total || "…"}
              </span>
            ) : (
              <span className="text-xs text-slate-500">
                {status.data?.counts.untagged ?? 0} untagged
              </span>
            )}
            <Link
              to="/settings"
              aria-label="Settings"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-slate-100"
            >
              <Settings size={18} />
            </Link>
          </div>
          {indexing?.running && (
            <div className="mx-auto mt-2 max-w-3xl">
              <div className="progress-track h-1">
                <div
                  className="progress-fill"
                  style={{
                    width: `${indexing.total ? Math.round((indexing.scanned / indexing.total) * 100) : 15}%`,
                  }}
                />
              </div>
            </div>
          )}
        </header>
        <main className="page">
          {task?.running &&
            !(
              location.pathname === "/migration" &&
              (task.kind === "migration-scan" ||
                task.kind === "migration-apply")
            ) && (
              <div className="mb-4 rounded-2xl border border-sky-300/30 bg-sky-300/10 p-3 text-sm text-sky-100">
                <div className="flex items-center gap-2">
                  <Loader2 size={16} className="shrink-0 animate-spin" />
                  <span className="flex-1 font-semibold">
                    {taskLabel(task.kind)}
                  </span>
                  <span className="tabular-nums text-xs text-sky-200">
                    {task.processed.toLocaleString()}
                    {task.total > 0 ? ` / ${task.total.toLocaleString()}` : ""}
                  </span>
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
                {task.errors > 0 && (
                  <p className="mt-1 text-xs text-amber-200">
                    {task.errors} error{task.errors === 1 ? "" : "s"} so far
                  </p>
                )}
              </div>
            )}
          {status.isError && (
            <div className="mb-4 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100">
              Connection problem. Showing the last known data; retrying in the
              background.
            </div>
          )}
          {legacyPending > 0 && location.pathname !== "/migration" && (
            <Link
              to="/migration"
              className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-300/30 bg-amber-300/10 p-3 text-sm text-amber-100 transition-colors hover:bg-amber-300/15"
            >
              <AlertTriangle size={18} className="mt-0.5 shrink-0" />
              <span className="flex-1">
                <strong>{legacyPending}</strong>{" "}
                {legacyPending === 1 ? "file still uses" : "files still use"}{" "}
                the old filename/description tags. Map them to key-value tags
                once, then they join the normal library.
              </span>
              <span className="flex shrink-0 items-center gap-1 font-semibold text-amber-200">
                Open <ArrowRight size={14} />
              </span>
            </Link>
          )}
          {children}
        </main>
      </div>
      <nav className="nav">
        {links.slice(0, 5).map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}
          >
            <link.icon size={20} />
            <span>{link.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
