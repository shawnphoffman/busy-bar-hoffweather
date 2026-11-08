// The last known state of an app, kept in localStorage so the next launch can paint it at once (instead of the
// firmware's "Loading..." screen) and refresh in the background.
//
// Every localStorage.setItem rewrites the app's whole store to flash, so a snapshot is written only when what it
// would show has changed, or on a slow heartbeat that keeps its age honest while nothing changes. Keep snapshots
// small, and keep secrets out of them: settings already hold those.

export interface Snapshot<T> {
  /** When the data was last confirmed current, ms since the epoch. */
  savedAt: number;
  data: T;
}

interface Stored<T> extends Snapshot<T> {
  /** What the data shows, compared to skip writes that would change nothing visible. */
  content: string;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The last write per key, so a save does not need to read flash back. */
const written: Record<string, { content: string; savedAt: number }> = {};

/** The stored snapshot, or null when there is none, it cannot be read, or the clock says it is from the future. */
export function readSnapshot<T>(key: string): Snapshot<T> | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored<T>>;
    if (typeof v.savedAt !== "number" || typeof v.content !== "string" || !("data" in v)) return null;
    if (v.savedAt > Date.now() + 60000) return null;
    written[key] = { content: v.content, savedAt: v.savedAt };
    return { savedAt: v.savedAt, data: v.data as T };
  } catch {
    return null;
  }
}

/**
 * Stores `data` as confirmed now, unless `content` matches the last write and that write is younger than
 * `heartbeatMs`. Returns whether it wrote. Failures (no storage, full store) are ignored: the cache is a nicety.
 */
export function saveSnapshot<T>(key: string, data: T, content: string, heartbeatMs: number): boolean {
  const now = Date.now();
  const last = written[key];
  if (last && last.content === content && now - last.savedAt < heartbeatMs) return false;
  const store = storage();
  if (!store) return false;
  try {
    const record: Stored<T> = { savedAt: now, content, data };
    store.setItem(key, JSON.stringify(record));
    written[key] = { content, savedAt: now };
    return true;
  } catch {
    return false;
  }
}

/** How old a timestamp is, never negative (the bar's clock can step when it syncs). */
export function ageOf(at: number): number {
  return Math.max(0, Date.now() - at);
}
