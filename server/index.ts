import express from "express";
import fs from "node:fs";
import path from "node:path";
import { config, serverLog } from "./config";
import { db } from "./db";
import { router } from "./routes";
import { startIndexer, stopIndexer, indexState } from "./indexer";
import { closeMetadata } from "./metadata";
import { startPushScheduler } from "./push";
import { startDbSnapshots, stopDbSnapshots } from "./backup";
import { isTaskRunning } from "./tasks";

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.use("/api", router);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const webDist = path.join(config.appRoot, "web", "dist");
if (fs.existsSync(webDist)) {
  app.use(
    express.static(webDist, {
      index: false,
      maxAge: "1h",
      setHeaders: (res, filePath) => {
        if (
          filePath.endsWith("sw.js") ||
          filePath.endsWith("manifest.webmanifest")
        ) {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    }),
  );
}

app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) return next();
  const index = path.join(webDist, "index.html");
  if (fs.existsSync(index)) {
    res.setHeader("Cache-Control", "no-cache");
    return res.sendFile(index);
  }
  res
    .status(503)
    .type("text/plain")
    .send(
      "LifeTagger web assets are not built. Run `npm run build:web` or use the Vite dev server.",
    );
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    serverLog.error("request failed", error);
    if (res.headersSent) return;
    const status = error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({
      error:
        error instanceof SyntaxError
          ? "Malformed JSON body"
          : error instanceof Error
            ? error.message
            : "Internal server error",
    });
  },
);

const server = app.listen(config.port, config.host, () => {
  serverLog.info(
    `LifeTagger listening on http://${config.host}:${config.port}`,
  );
  startIndexer();
  startPushScheduler();
  startDbSnapshots();
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  serverLog.info(`shutting down (${signal})`);
  stopIndexer();
  stopDbSnapshots();
  server.close();
  // Do not close the database or ExifTool underneath a long-running job.
  // Kubernetes will terminate the process after its grace period.
  const longTaskRunning = indexState.running || isTaskRunning();
  if (!longTaskRunning) {
    try {
      db.close();
    } catch {
      // already closed
    }
    await closeMetadata().catch(() => undefined);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) =>
  serverLog.error("unhandled rejection", error),
);
process.on("uncaughtException", (error) =>
  serverLog.error("uncaught exception", error),
);
