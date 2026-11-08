import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  Download,
  Loader2,
  RefreshCw,
  Save,
  ScanFace,
  ShieldCheck,
  Tags,
} from "lucide-react";
import { api } from "../api";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export default function SettingsPage() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const status = useQuery({
    queryKey: ["status"],
    queryFn: api.status,
    refetchInterval: (query) =>
      query.state.data?.indexing.running ? 2500 : false,
  });
  const [form, setForm] = useState<{
    mediaRoot: string;
    dailyGoal: number;
    reminderTime: string;
    timezone: string;
    suggestionRadiusM: number;
    facesEnabled: boolean;
    faceScanMode: "on-demand" | "background";
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(
    null,
  );
  const indexing = status.data?.indexing.running ?? false;
  const taskRunning = Boolean(status.data?.task?.running);

  useEffect(() => {
    if (!settings.data || form) return;
    setForm({
      mediaRoot: settings.data.mediaRoot ?? "",
      dailyGoal: settings.data.dailyGoal,
      reminderTime: settings.data.reminderTime,
      timezone: settings.data.timezone,
      suggestionRadiusM: settings.data.suggestionRadiusM,
      facesEnabled: settings.data.facesEnabled,
      faceScanMode: settings.data.faceScanMode,
    });
  }, [settings.data, form]);

  useEffect(() => {
    const captured = window.__lifetaggerInstallPrompt;
    if (captured) setInstallPrompt(captured as InstallPromptEvent);
    const listener = (event: Event) => {
      event.preventDefault();
      window.__lifetaggerInstallPrompt = event;
      setInstallPrompt(event as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", listener);
    return () => window.removeEventListener("beforeinstallprompt", listener);
  }, []);

  const save = useMutation({
    mutationFn: () => api.updateSettings(form!),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      client.invalidateQueries({ queryKey: ["settings"] });
      client.invalidateQueries({ queryKey: ["status"] });
      client.invalidateQueries({ queryKey: ["batch"] });
      client.invalidateQueries({ queryKey: ["files"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not save settings",
      ),
  });

  const rescan = useMutation({
    mutationFn: api.rescan,
    onSuccess: (result) => {
      if (result.started === false) {
        setError(result.reason ?? "The rescan did not start");
      } else {
        setError(null);
      }
      client.invalidateQueries({ queryKey: ["status"] });
    },
    onError: (mutationError) =>
      setError(
        mutationError instanceof Error
          ? mutationError.message
          : "Could not start the rescan",
      ),
  });

  if (settings.isError && !settings.data) {
    return (
      <div className="card p-6">
        <h1 className="text-lg font-semibold">Settings could not be loaded</h1>
        <p className="mt-2 text-sm text-slate-400">
          {settings.error instanceof Error
            ? settings.error.message
            : "The server did not respond."}
        </p>
        <button className="btn mt-4" onClick={() => settings.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  if (!form) return <div className="skeleton h-96 rounded-3xl" />;

  const formInvalid =
    !form.mediaRoot.trim() ||
    !Number.isFinite(form.dailyGoal) ||
    form.dailyGoal < 1 ||
    form.dailyGoal > 100 ||
    !Number.isFinite(form.suggestionRadiusM) ||
    form.suggestionRadiusM < 50 ||
    form.suggestionRadiusM > 20_000 ||
    !form.reminderTime ||
    !form.timezone.trim();
  const rootChanged =
    form.mediaRoot.trim() !== (settings.data?.mediaRoot ?? "").trim();

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-teal-300">
          Settings
        </p>
        <h1 className="text-2xl font-bold tracking-tight">Make it yours</h1>
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="text-sm font-semibold">Library</h2>
        <label>
          <span className="label">Media folder on the server</span>
          <input
            className="input"
            value={form.mediaRoot}
            disabled={indexing || taskRunning}
            onChange={(event) =>
              setForm({ ...form, mediaRoot: event.target.value })
            }
            placeholder="/media"
          />
          <span className="mt-1 block text-xs text-slate-500">
            In the container this is normally{" "}
            <code className="text-slate-400">/media</code>; pick a subfolder if
            you only want part of the tree.
            {indexing &&
              " The folder cannot be changed while the library is indexing."}
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className="label">Daily goal</span>
            <input
              type="number"
              min={1}
              max={100}
              className="input"
              value={form.dailyGoal}
              onChange={(event) =>
                setForm({ ...form, dailyGoal: Number(event.target.value) })
              }
            />
          </label>
          <label>
            <span className="label">Suggestion radius (m)</span>
            <input
              type="number"
              min={50}
              max={20000}
              className="input"
              value={form.suggestionRadiusM}
              onChange={(event) =>
                setForm({
                  ...form,
                  suggestionRadiusM: Number(event.target.value),
                })
              }
            />
          </label>
          <label>
            <span className="label">Reminder time</span>
            <input
              type="time"
              className="input"
              value={form.reminderTime}
              onChange={(event) =>
                setForm({ ...form, reminderTime: event.target.value })
              }
            />
          </label>
          <label>
            <span className="label">Timezone</span>
            <input
              className="input"
              value={form.timezone}
              onChange={(event) =>
                setForm({ ...form, timezone: event.target.value })
              }
              placeholder="America/Toronto"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className="btn btn-primary"
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              formInvalid ||
              ((indexing || taskRunning) && rootChanged)
            }
          >
            {save.isPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Save size={16} />
            )}
            Save settings
          </button>
          <button
            className="btn"
            onClick={() => rescan.mutate()}
            disabled={rescan.isPending || indexing || taskRunning}
            title={
              indexing
                ? "Wait for the current index to finish"
                : taskRunning
                  ? "Wait for the running task to finish"
                  : undefined
            }
          >
            {rescan.isPending || indexing ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <RefreshCw size={16} />
            )}
            {indexing ? "Indexing…" : "Rescan library"}
          </button>
          {saved && (
            <span className="self-center text-sm text-teal-300">Saved.</span>
          )}
        </div>
        {error && (
          <div className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-200">
            {error}
          </div>
        )}
        {status.data?.indexing.running && (
          <p className="text-xs text-amber-300">
            Indexing {status.data.indexing.scanned}/{status.data.indexing.total}{" "}
            · {status.data.indexing.indexed} indexed ·{" "}
            {status.data.indexing.errors} errors
          </p>
        )}
      </div>

      <div className="card space-y-4 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ScanFace size={17} className="text-teal-300" /> Face recognition
        </h2>
        <label className="flex items-center justify-between gap-4 text-sm">
          <span>
            Enable local face detection
            <span className="mt-0.5 block text-xs text-slate-500">
              Models run on this server; nothing is uploaded.
            </span>
          </span>
          <input
            type="checkbox"
            checked={form.facesEnabled}
            onChange={(event) =>
              setForm({ ...form, facesEnabled: event.target.checked })
            }
          />
        </label>
        <label>
          <span className="label">Scanning mode</span>
          <select
            className="input"
            value={form.faceScanMode}
            onChange={(event) =>
              setForm({
                ...form,
                faceScanMode: event.target.value as "on-demand" | "background",
              })
            }
          >
            <option value="on-demand">
              On demand (recommended for large libraries)
            </option>
            <option value="background">Background scan everything</option>
          </select>
        </label>
        <p className="text-xs text-slate-500">
          {form.faceScanMode === "on-demand"
            ? "Faces are checked when a photo or video enters your daily batch or you open it. This keeps a 100k-file library from turning into a multi-day CPU job."
            : "Every indexed photo and video is queued for face detection. Videos use their poster frame. This can take a long time on a large library."}
        </p>
      </div>

      <PushSettings pushConfigured={settings.data?.pushConfigured ?? false} />

      <div className="card space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Tags size={17} className="text-teal-300" /> Tag vocabulary
        </h2>
        <p className="text-sm text-slate-400">
          Merge spelling variants and keep suggestions sharp.
        </p>
        <Link to="/tags" className="btn w-fit">
          Open tag manager
        </Link>
      </div>

      <div className="card space-y-3 p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck size={17} className="text-teal-300" /> Migration & data
        </h2>
        <p className="text-sm text-slate-400">
          Legacy filename tags are detected and excluded from daily batches
          until you map them to key-value tags.
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to="/migration" className="btn">
            Open migration wizard
          </Link>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </div>
        <p className="text-xs text-slate-500">
          Data directory:{" "}
          <code className="text-slate-400">{status.data?.dataDir}</code>
        </p>
      </div>

      {installPrompt && (
        <button
          className="btn btn-primary w-full"
          onClick={async () => {
            await installPrompt.prompt();
            window.__lifetaggerInstallPrompt = undefined;
            setInstallPrompt(null);
          }}
        >
          <Download size={16} /> Install LifeTagger
        </button>
      )}
    </div>
  );
}

function PushSettings({ pushConfigured }: { pushConfigured: boolean }) {
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setSubscribed(Boolean(subscription)))
      .catch(() => setSubscribed(false));
  }, []);

  async function subscribe() {
    setBusy(true);
    setMessage(null);
    try {
      if (!("Notification" in window) || !("serviceWorker" in navigator))
        throw new Error("This browser does not support notifications.");
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error("Notification permission was not granted.");
      const { publicKey } = await api.pushKey();
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      await api.subscribePush(subscription.toJSON());
      setSubscribed(true);
      setMessage("Notifications enabled.");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not enable notifications.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api.unsubscribePush(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setSubscribed(false);
      setMessage("Notifications disabled.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3 p-5">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Bell size={17} className="text-teal-300" /> Daily reminder
      </h2>
      {!pushConfigured ? (
        <p className="text-sm text-slate-400">
          Push is not configured on the server. Add{" "}
          <code className="text-slate-300">VAPID_PUBLIC_KEY</code>,{" "}
          <code className="text-slate-300">VAPID_PRIVATE_KEY</code>, and{" "}
          <code className="text-slate-300">VAPID_SUBJECT</code> to enable it.
        </p>
      ) : (
        <>
          <p className="text-sm text-slate-400">
            A notification at your reminder time, only when today’s batch is
            unfinished. On iPhone, install the app to the Home Screen first.
          </p>
          <div className="flex flex-wrap gap-2">
            {subscribed ? (
              <button className="btn" onClick={unsubscribe} disabled={busy}>
                {busy ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Bell size={15} />
                )}{" "}
                Disable notifications
              </button>
            ) : (
              <button
                className="btn btn-primary"
                onClick={subscribe}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Bell size={15} />
                )}{" "}
                Enable notifications
              </button>
            )}
            {subscribed && (
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await api.testPush();
                    setMessage("Test notification sent.");
                  } catch (error) {
                    setMessage(
                      error instanceof Error ? error.message : "Test failed.",
                    );
                  }
                }}
              >
                Send test
              </button>
            )}
          </div>
          {message && <p className="text-xs text-slate-400">{message}</p>}
        </>
      )}
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; ++i) output[i] = raw.charCodeAt(i);
  return output;
}
