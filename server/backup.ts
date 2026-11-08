import fs from "node:fs";
import path from "node:path";
import { config, serverLog } from "./config";
import { db } from "./db";

let snapshotTimer: NodeJS.Timeout | null = null;

export function createDbSnapshot(): string | null {
  try {
    fs.mkdirSync(config.dbSnapshotsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(
      config.dbSnapshotsDir,
      `lifetagger-${stamp}.sqlite`,
    );
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const files = fs
      .readdirSync(config.dbSnapshotsDir)
      .filter((file) => file.endsWith(".sqlite"))
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - 7))) {
      fs.unlinkSync(path.join(config.dbSnapshotsDir, old));
    }
    serverLog.info("database snapshot created", target);
    return target;
  } catch (error) {
    serverLog.warn("database snapshot failed", error);
    return null;
  }
}

export function startDbSnapshots(): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    createDbSnapshot();
    snapshotTimer = setInterval(createDbSnapshot, 24 * 60 * 60 * 1000);
    snapshotTimer.unref?.();
  }, 30_000);
  snapshotTimer.unref?.();
}

export function stopDbSnapshots(): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
}
