import { Navigate, Route, Routes } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, LogIn } from "lucide-react";
import { api, AuthRequiredError } from "./api";
import { Layout } from "./components/Layout";
import TodayPage from "./pages/Today";
import LibraryPage from "./pages/Library";
import FileDetailPage from "./pages/FileDetail";
import PeoplePage from "./pages/People";
import TagsPage from "./pages/Tags";
import StatsPage from "./pages/Stats";
import SettingsPage from "./pages/Settings";
import MigrationPage from "./pages/Migration";
import SetupPage from "./pages/Setup";

export default function App() {
  const status = useQuery({ queryKey: ["status"], queryFn: api.status });

  if (status.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-slate-400">
        <Loader2 className="animate-spin" size={22} />
      </div>
    );
  }

  if (status.isError) {
    const authRequired = status.error instanceof AuthRequiredError;
    return (
      <div className="flex min-h-screen items-center justify-center p-5">
        <div className="card max-w-md p-6 text-center">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-slate-800 text-slate-300">
            <LogIn size={22} />
          </div>
          <h1 className="mt-4 text-xl font-bold">
            {authRequired ? "Sign in to continue" : "LifeTagger is unavailable"}
          </h1>
          <p className="mt-2 text-sm text-slate-400">
            {authRequired
              ? "Your session has expired. Reload the page after signing in."
              : status.error instanceof Error
                ? status.error.message
                : "The server did not respond."}
          </p>
          <button
            className="btn btn-primary mt-4 w-full"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }

  if (!status.data?.configured) return <SetupPage />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/today" replace />} />
        <Route path="/today" element={<TodayPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/file/:id" element={<FileDetailPage />} />
        <Route path="/people" element={<PeoplePage />} />
        <Route path="/tags" element={<TagsPage />} />
        <Route path="/stats" element={<StatsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/migration" element={<MigrationPage />} />
        <Route path="*" element={<Navigate to="/today" replace />} />
      </Routes>
    </Layout>
  );
}
