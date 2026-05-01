/** Gmail `users.threads.list` allows at most 500 results per request. */
export const GMAIL_THREADS_LIST_PAGE_CAP = 500;

export function maxInboxThreadsFromEnv(): number {
  const raw = Number(process.env.GMAIL_MAX_THREADS ?? 5000);
  if (!Number.isFinite(raw) || raw < 1) {
    return 5000;
  }
  return Math.min(10_000, Math.floor(raw));
}

export function parseInboxThreadLimit(raw: string | null): number {
  const defaultLimit = 200;
  const cap = maxInboxThreadsFromEnv();
  if (raw == null || raw === "") {
    return Math.min(defaultLimit, cap);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) {
    return Math.min(defaultLimit, cap);
  }
  return Math.min(n, cap);
}

/** Presets shown in the inbox load UI (server still clamps to `GMAIL_MAX_THREADS`). */
export const INBOX_THREAD_PRESETS = [
  200, 300, 400, 500, 750, 1000, 1500, 2000, 2500,
] as const;
