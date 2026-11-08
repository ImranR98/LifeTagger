import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config, serverLog } from "./config";
import { indexState } from "./indexer";

const execFileAsync = promisify(execFile);
let snapshotTimer: NodeJS.Timeout | null = null;
const SNAPSHOT_RETRY_MS = 10 * 60 * 1000;
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000;

const snapshotScript = `
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[1]);
db.exec("PRAGMA busy_timeout = 30000");
db.exec("VACUUM INTO '" + process.argv[2].replace(/'/g, "''") + "'");
db.close();
`;

export async function createDbSnapshot(): Promise<string | null> {
  if (indexState.running) return null;
  try {
    fs.mkdirSync(config.dbSnapshotsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = path.join(
      config.dbSnapshotsDir,
      `lifetagger-${stamp}.sqlite`,
    );
    // Run in a child process: VACUUM is synchronous and would otherwise freeze
    // the HTTP server for the duration of a large database copy.
    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", snapshotScript, config.dbPath, target],
      { timeout: 10 * 60 * 1000 },
    );
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

function scheduleSnapshot(delay: number): void {
  snapshotTimer = setTimeout(async () => {
    if (indexState.running) {
      scheduleSnapshot(SNAPSHOT_RETRY_MS);
      return;
    }
    await createDbSnapshot();
    scheduleSnapshot(SNAPSHOT_INTERVAL_MS);
  }, delay);
  snapshotTimer.unref?.();
}

export function startDbSnapshots(): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  scheduleSnapshot(30_000);
}

export function stopDbSnapshots(): void {
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = null;
}
