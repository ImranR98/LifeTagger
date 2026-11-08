/// <reference lib="webworker" />

import { precacheAndRoute } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision?: string | null }>;
};

// Do not add a NavigationRoute here. Top-level navigations must reach the
// reverse proxy so forward-auth can redirect to the login page. Serving a
// cached app shell for navigations bypasses that flow and leaves the user
// stuck with API requests that redirect to a login page.
precacheAndRoute(self.__WB_MANIFEST);

type PushPayload = {
  title?: string;
  body?: string;
  url?: string;
};

self.addEventListener("push", (event) => {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() ?? {}) as PushPayload;
  } catch {
    payload = { body: event.data?.text() ?? "" };
  }
  event.waitUntil(
    self.registration.showNotification(payload.title || "LifeTagger", {
      body: payload.body || "A few photos are waiting for a quick tag.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: payload.url || "/today" },
      tag: "lifetagger-daily",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const rawUrl =
    (event.notification.data as { url?: string } | undefined)?.url || "/today";
  const url = new URL(rawUrl, self.location.origin).href;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find(
          (client) => new URL(client.url).origin === self.location.origin,
        );
        if (existing) {
          existing.focus();
          existing.navigate(url);
          return;
        }
        return self.clients.openWindow(url);
      }),
  );
});
