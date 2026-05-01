import {
  bucketUsesBillsSemantics,
  bucketUsesReceiptSemantics,
  bucketUsesStrictSemantics,
  semanticJobsMatch,
  transactionalMoneyBucketMatches,
} from "@/lib/bucketSemantics";
import { normalizeActiveBucketsForClassification, pickNeutralFallback } from "@/lib/activeBuckets";
import type { BucketName, BucketedThreads, EmailThread } from "@/lib/types";

/** Scan subject + preview + sender — most mislabels come from ignoring snippet text. */
const NEWSLETTER_BLOB_HINTS = [
  "newsletter",
  "digest",
  "unsubscribe",
  "weekly roundup",
  "weekly update",
  "your weekly",
  "subscriber",
  "% off",
  "free shipping",
  "black friday",
  "exclusive sale",
  "email only",
  "sale for subscribers",
  "subscribers-only",
  "for subscribers",
  "preview:",
  "launching tomorrow",
];

const IMPORTANT_BLOB_HINTS = [
  "urgent",
  "asap",
  "needs your review",
  "please review",
  "security alert",
  "unusual sign-in",
  "password was changed",
  "action required",
];

const AUTO_ARCHIVE_BLOB_HINTS = [
  "verification code",
  "one-time password",
  "otp:",
  "passwordless sign-in",
  "sign-in attempt",
  "tracking number",
  "out for delivery",
  "package shipped",
];

function normalizeBlob(thread: EmailThread) {
  return `${thread.subject} ${thread.preview} ${thread.sender}`.toLowerCase();
}

function tokenizeBucketName(bucket: string) {
  return bucket
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3);
}

function strictSemanticBucket(thread: EmailThread, bucket: BucketName): boolean {
  const key = bucket.trim().toLowerCase();
  return (
    (/^jobs?$/.test(key) || /^job\s*hunt(ing)?$/.test(key)) &&
    semanticJobsMatch(thread)
  );
}

function classifyCustomBucket(
  thread: EmailThread,
  customBuckets: BucketName[]
): BucketName | null {
  const transactional = customBuckets.filter((b) =>
    bucketUsesReceiptSemantics(b)
  );

  /**
   * When both Receipts + Bills exist, evaluate Bills-first so overdue threads that
   * also trigger receipt-like keywords land on payables.
   */
  if (transactional.length > 0) {
    const ordered = transactional.slice().sort((a, b) => {
      const aw = bucketUsesBillsSemantics(a) ? 0 : 1;
      const bw = bucketUsesBillsSemantics(b) ? 0 : 1;
      return aw - bw;
    });
    for (const bucket of ordered) {
      if (transactionalMoneyBucketMatches(thread, bucket, transactional)) {
        return bucket;
      }
    }
  }

  const haystack = normalizeBlob(thread);
  for (const bucket of customBuckets) {
    if (bucketUsesReceiptSemantics(bucket)) {
      continue;
    }
    if (bucketUsesStrictSemantics(bucket)) {
      if (strictSemanticBucket(thread, bucket)) {
        return bucket;
      }
      continue;
    }

    const hints = tokenizeBucketName(bucket);
    if (hints.length === 0) {
      continue;
    }
    if (hints.some((hint) => haystack.includes(hint))) {
      return bucket;
    }
  }
  return null;
}

/** Defaults when LLM misses — only assigns labels that remain in `allowed`. */
function classifyFallbackThread(thread: EmailThread, allowed: BucketName[]): BucketName {
  const allowList = normalizeActiveBucketsForClassification(allowed);
  const blob = normalizeBlob(thread);
  const canUse = (name: BucketName) => allowList.includes(name);

  for (const hint of NEWSLETTER_BLOB_HINTS) {
    if (blob.includes(hint) && canUse("Newsletter")) {
      return "Newsletter";
    }
  }

  const looksLikePromotion =
    /\b(sale|deal|coupon|discount|shop now|browse|collection)\b/i.test(blob);
  if (
    looksLikePromotion &&
    /\b(no-reply|noreply|mailer\.|marketing|news@)/i.test(thread.sender.toLowerCase()) &&
    canUse("Newsletter")
  ) {
    return "Newsletter";
  }

  for (const hint of AUTO_ARCHIVE_BLOB_HINTS) {
    if (blob.includes(hint) && canUse("Auto-archive")) {
      return "Auto-archive";
    }
  }

  for (const hint of IMPORTANT_BLOB_HINTS) {
    if (blob.includes(hint) && canUse("Important")) {
      return "Important";
    }
  }

  return pickNeutralFallback(allowList) as BucketName;
}

export function inferBucketForThread(
  thread: EmailThread,
  activeBuckets: BucketName[] = []
): BucketName {
  const normalized = normalizeActiveBucketsForClassification(activeBuckets);
  const customBucket = classifyCustomBucket(thread, normalized);
  if (customBucket) {
    return customBucket;
  }
  return classifyFallbackThread(thread, normalized);
}

export function classifyThreads(
  threads: EmailThread[],
  activeBuckets: BucketName[] = []
): BucketedThreads {
  const allBuckets = normalizeActiveBucketsForClassification(activeBuckets);
  const output: BucketedThreads = {};
  for (const bucket of allBuckets) {
    output[bucket] = [];
  }

  for (const thread of threads) {
    const customBucket = classifyCustomBucket(thread, allBuckets);
    if (customBucket && output[customBucket]) {
      output[customBucket].push(thread);
      continue;
    }

    const primary = classifyFallbackThread(thread, allBuckets);
    output[primary].push(thread);
  }

  return output;
}
