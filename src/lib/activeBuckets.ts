import { DEFAULT_BUCKETS } from "@/lib/buckets";
import type { BucketName } from "@/lib/types";
import { type SavedBucketsPayload, validateBucketList } from "@/lib/savedCustomBuckets";

export const BUCKET_LIST_STORAGE_V2 = 2;

/** If the list has zero built-in presets, prepend the four defaults (dedup). Preserves intentional lists that still include ≥1 preset. */
function ensureDefaultPresetsPrepended(validatedOrdered: BucketName[]): BucketName[] {
  if (validatedOrdered.length === 0) {
    return [...DEFAULT_BUCKETS];
  }
  const presetNames = new Set(DEFAULT_BUCKETS);
  if (validatedOrdered.some((b) => presetNames.has(b))) {
    return validatedOrdered;
  }
  return (
    validateBucketList([...DEFAULT_BUCKETS, ...validatedOrdered]) ?? [...DEFAULT_BUCKETS]
  );
}

/** Persisted Postgres `SavedCustomBuckets.buckets` Json: legacy string[] additive, or `{ v:2, buckets }` full list. */
export function bucketsFromDatabaseJson(raw: unknown): BucketName[] {
  if (raw == null) {
    return [...DEFAULT_BUCKETS];
  }

  if (Array.isArray(raw)) {
    const customs = validateBucketList(raw);
    const merged =
      customs && customs.length > 0
        ? validateBucketList([...DEFAULT_BUCKETS, ...customs])
        : null;
    return merged ?? [...DEFAULT_BUCKETS];
  }

  if (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { v?: unknown }).v === BUCKET_LIST_STORAGE_V2 &&
    Array.isArray((raw as { buckets?: unknown }).buckets)
  ) {
    const full = validateBucketList((raw as { buckets: unknown[] }).buckets);
    if (full && full.length > 0) {
      return ensureDefaultPresetsPrepended(full);
    }
    return [...DEFAULT_BUCKETS];
  }

  return [...DEFAULT_BUCKETS];
}

export function wrapBucketListForDatabase(buckets: string[]): {
  v: typeof BUCKET_LIST_STORAGE_V2;
  buckets: string[];
} {
  const list = validateBucketList(buckets) ?? [];
  return { v: BUCKET_LIST_STORAGE_V2, buckets: list };
}

/** Session-storage triage blobs: legacy stored additive-only customs; v2 stores the full UI list. */
export const TRIAGE_BUCKET_LIST_FV = 2;

export function triageBucketsFromBlob(
  buckets: string[] | undefined,
  blobFormat?: typeof TRIAGE_BUCKET_LIST_FV,
): BucketName[] {
  const raw = buckets ?? [];
  if (blobFormat === TRIAGE_BUCKET_LIST_FV) {
    return ensureDefaultPresetsPrepended(
      normalizeActiveBucketsForClassification(raw as BucketName[]),
    );
  }
  const customs = validateBucketList(raw);
  const merged =
    customs && customs.length > 0
      ? validateBucketList([...DEFAULT_BUCKETS, ...customs])
      : null;
  return merged ?? [...DEFAULT_BUCKETS];
}

/** Non-empty list for classify + UI; blank input falls back to built-in defaults. */
export function normalizeActiveBucketsForClassification(
  buckets: BucketName[],
): BucketName[] {
  const validated = validateBucketList(buckets) ?? [];
  return validated.length > 0 ? validated : [...DEFAULT_BUCKETS];
}

/**
 * Persisted/account list is flattened; split into presets the user hid vs names they added themselves.
 */
export function splitStoredBucketList(storedMerged: BucketName[]): {
  excludedPresets: BucketName[];
  extras: BucketName[];
} {
  const list = validateBucketList(storedMerged) ?? [];
  const defaultSet = new Set(DEFAULT_BUCKETS);
  const foundPresetsOnDisk = DEFAULT_BUCKETS.filter((d) => list.includes(d));
  const extras = list.filter((b) => !defaultSet.has(b));

  /** Saved list contained no preset names → treat like legacy “extras only”; show all presets + extras */
  if (foundPresetsOnDisk.length === 0 && extras.length > 0) {
    return { excludedPresets: [], extras };
  }

  const excluded = DEFAULT_BUCKETS.filter((d) => !foundPresetsOnDisk.includes(d));
  return { excludedPresets: excluded, extras };
}

/**
 * Active classification list from (1) presets the user hasn’t turned off + (2) user-added buckets only.
 */
export function flattenBucketSelection(
  excludedPresetNames: readonly BucketName[],
  extrasInput: readonly string[],
): BucketName[] {
  const excludedNorm = [...new Set(excludedPresetNames ?? [])].filter((x) =>
    DEFAULT_BUCKETS.includes(x as BucketName),
  );
  const excludedSet = new Set(excludedNorm);
  const presetPart = DEFAULT_BUCKETS.filter((b) => !excludedSet.has(b));

  let extrasRaw = validateBucketList([...extrasInput]) ?? [];
  extrasRaw = extrasRaw.filter(
    (b) =>
      !DEFAULT_BUCKETS.some(
        (d) => d.trim().toLowerCase() === b.trim().toLowerCase(),
      ),
  );

  const activePresetLc = new Set(presetPart.map((p) => p.toLowerCase()));
  extrasRaw = extrasRaw.filter((b) => !activePresetLc.has(b.trim().toLowerCase()));

  const combined = [...presetPart, ...extrasRaw];
  if (combined.length === 0) {
    return [...DEFAULT_BUCKETS];
  }
  const out =
    validateBucketList(combined) ??
    (presetPart.length ? presetPart : [...DEFAULT_BUCKETS]);
  return out.length > 0 ? out : [...DEFAULT_BUCKETS];
}

/** After removing built-ins, heuristic gap-fill prefers this label when present. */
export function pickNeutralFallback(orderedAllowed: string[]): string {
  if (orderedAllowed.length === 0) {
    return "Can wait";
  }
  if (orderedAllowed.includes("Can wait")) {
    return "Can wait";
  }
  return orderedAllowed[0];
}

export function resolveBucketToAllowed(
  bucket: string | null | undefined,
  orderedAllowed: string[],
): BucketName {
  const allow = orderedAllowed.filter(Boolean);
  if (!allow.length) {
    return "Can wait";
  }
  const trimmed =
    typeof bucket === "string" && bucket.trim()
      ? allow.find((b) => b === bucket.trim())
      : undefined;
  if (trimmed) {
    return trimmed;
  }
  return pickNeutralFallback(allow);
}

export function parseSavedBucketsCookie(
  raw: string | undefined,
  expectedAccountKey: string,
): BucketName[] | null {
  if (!raw?.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SavedBucketsPayload;
    if (parsed.k !== expectedAccountKey || !Array.isArray(parsed.b)) {
      return null;
    }
    const list = validateBucketList(parsed.b);
    if (!list || list.length === 0) {
      return [...DEFAULT_BUCKETS];
    }
    if (parsed.fv === BUCKET_LIST_STORAGE_V2) {
      return ensureDefaultPresetsPrepended(
        normalizeActiveBucketsForClassification(list),
      );
    }
    return normalizeActiveBucketsForClassification([
      ...DEFAULT_BUCKETS,
      ...list,
    ]);
  } catch {
    return null;
  }
}

/** Cookie stores `{ k, fv:2, b }` where `b` is the full active list (may be empty → defaults applied on GET). */
export function serializeSavedBucketsCookie(
  accountKey: string,
  buckets: string[],
): string {
  const normalized = normalizeActiveBucketsForClassification(
    (validateBucketList(buckets) ?? []) as BucketName[],
  );
  const payload: SavedBucketsPayload = {
    k: accountKey,
    fv: BUCKET_LIST_STORAGE_V2,
    b: normalized,
  };
  return JSON.stringify(payload);
}
