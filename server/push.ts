import { createRequire } from "node:module";
import type { PushSubscription } from "web-push";
import { config, serverLog } from "./config";

const require = createRequire(import.meta.url);
const webpush = require("web-push") as typeof import("web-push");
import {
  deletePushSubscription,
  getSetting,
  pushFailure,
  pushSubscriptions,
  savePushSubscription,
  setSetting,
  todayKey,
} from "./db";
import { getOrCreateBatch } from "./batch";

export function pushConfigured(): boolean {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey);
}

if (pushConfigured()) {
  webpush.setVapidDetails(
    config.vapidSubject,
    config.vapidPublicKey,
    config.vapidPrivateKey,
  );
}

export function vapidPublicKey(): string {
  return config.vapidPublicKey;
}

export function saveSubscription(subscription: PushSubscription): void {
  if (!subscription.endpoint?.startsWith("https://"))
    throw new Error("Invalid push endpoint");
  savePushSubscription(subscription.endpoint, JSON.stringify(subscription));
}

export function removeSubscription(endpoint: string): void {
  deletePushSubscription(endpoint);
}

export async function sendPush(payload: {
  title: string;
  body: string;
  url?: string;
}): Promise<number> {
  if (!pushConfigured()) return 0;
  const subscriptions = pushSubscriptions();
  let sent = 0;
  for (const row of subscriptions) {
    try {
      const subscription = JSON.parse(row.subscription) as PushSubscription;
      await webpush.sendNotification(
        subscription,
        JSON.stringify({ ...payload, url: payload.url ?? "/today" }),
      );
      sent++;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        deletePushSubscription(row.endpoint);
      } else {
        pushFailure(row.endpoint);
        serverLog.warn(
          "push failed",
          row.endpoint.slice(0, 48),
          status ?? error,
        );
      }
    }
  }
  return sent;
}

function currentTime(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

export async function maybeSendReminder(): Promise<void> {
  if (!pushConfigured()) return;
  const timezone = getSetting("timezone") || config.timezone;
  const reminderTime = getSetting("reminderTime") || "19:00";
  if (currentTime(timezone) !== reminderTime) return;
  const date = todayKey();
  if ((getSetting("lastPushDate") || "") === date) return;
  const batch = getOrCreateBatch(date);
  const pending = batch.items.length;
  if (pending === 0) return;
  const sent = await sendPush({
    title: "LifeTagger",
    body: `${pending} ${pending === 1 ? "photo is" : "photos are"} waiting for a quick tag.`,
    url: new URL("/today", config.publicUrl).href,
  });
  if (sent > 0) setSetting("lastPushDate", date);
}

let scheduler: NodeJS.Timeout | null = null;

export function startPushScheduler(): void {
  if (!pushConfigured() || scheduler) return;
  scheduler = setInterval(() => {
    maybeSendReminder().catch((error) =>
      serverLog.warn("reminder failed", error),
    );
  }, 30_000);
  scheduler.unref();
}
