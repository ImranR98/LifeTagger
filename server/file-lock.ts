/**
 * Serialize writes for a single file. Media metadata writes and automation
 * updates are async, so two operations can otherwise read the same tag
 * snapshot and overwrite each other.
 */
const tails = new Map<number, Promise<void>>();

export async function withFileLock<T>(
  fileId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(fileId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(fileId, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(fileId) === tail) tails.delete(fileId);
  }
}
