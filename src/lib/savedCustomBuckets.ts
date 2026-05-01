const MAX_BUCKETS = 40;
const MAX_NAME_LEN = 80;

export const SAVED_BUCKETS_COOKIE = "inbox_saved_buckets_v1";

export type SavedBucketsPayload = {
  /** First 32 hex chars of sha256(refresh_token), matches accountKey elsewhere */
  k: string;
  b: string[];
};

export function parseSavedBucketsCookie(
  raw: string | undefined,
  expectedAccountKey: string,
): string[] | null {
  if (!raw?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SavedBucketsPayload;
    if (parsed.k !== expectedAccountKey || !Array.isArray(parsed.b)) {
      return null;
    }
    return validateBucketList(parsed.b);
  } catch {
    return null;
  }
}

export function serializeSavedBucketsCookie(
  accountKey: string,
  buckets: string[],
): string {
  const payload: SavedBucketsPayload = {
    k: accountKey,
    b: validateBucketList(buckets) ?? [],
  };
  return JSON.stringify(payload);
}

/** Returns normalized list or null if invalid. */
export function validateBucketList(input: unknown): string[] | null {
  if (!Array.isArray(input)) {
    return null;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") {
      continue;
    }
    const name = item.trim();
    if (!name || name.length > MAX_NAME_LEN) {
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_BUCKETS) {
      break;
    }
  }
  return out;
}
