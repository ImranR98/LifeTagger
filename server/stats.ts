import type { StatsResponse } from "../shared/types";
import { db, last30DaysActivity, statsTotals, todayKey, topKeys } from "./db";

type DayRow = { date: string; done: number; total: number };

function days(): DayRow[] {
  return db
    .prepare(
      `SELECT date, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done, COUNT(*) AS total
       FROM daily_items GROUP BY date ORDER BY date DESC`,
    )
    .all() as DayRow[];
}

function previousDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

export function computeStreak(
  rows: DayRow[],
  today = todayKey(),
): { current: number; longest: number } {
  const active = new Set(
    rows.filter((row) => row.done > 0).map((row) => row.date),
  );
  let cursor = active.has(today) ? today : previousDay(today);
  let current = 0;
  while (active.has(cursor)) {
    current++;
    cursor = previousDay(cursor);
  }
  const sorted = Array.from(active).sort();
  let longest = 0;
  let run = 0;
  let last = "";
  for (const date of sorted) {
    run = last && previousDay(date) === last ? run + 1 : 1;
    longest = Math.max(longest, run);
    last = date;
  }
  return { current, longest };
}

export function stats(): StatsResponse {
  const rows = days();
  const streak = computeStreak(rows);
  const totals = statsTotals();
  const indexed = (
    db.prepare("SELECT COUNT(*) AS count FROM files").get() as { count: number }
  ).count;
  const pending = (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM daily_items WHERE date = ? AND status = 'pending'",
      )
      .get(todayKey()) as { count: number }
  ).count;
  return {
    streak: streak.current,
    longestStreak: streak.longest,
    totalTagged: totals.totalTagged,
    totalManuallyTagged: totals.totalManuallyTagged,
    totalAutoOnly: totals.totalAutoOnly,
    totalFiles: totals.totalFiles,
    indexedFiles: indexed,
    pendingBatches: pending,
    last30Days: last30DaysActivity(),
    topKeys: topKeys(),
  };
}
