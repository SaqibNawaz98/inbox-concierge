import { DEFAULT_BUCKETS } from "@/lib/buckets";
import type { BucketName, BucketedThreads, EmailThread } from "@/lib/types";

const NEWSLETTER_HINTS = ["newsletter", "digest", "unsubscribe", "deals"];
const IMPORTANT_HINTS = ["review", "feedback", "urgent", "asap", "planning"];

function classifySubject(subject: string): BucketName {
  const normalized = subject.toLowerCase();

  if (NEWSLETTER_HINTS.some((hint) => normalized.includes(hint))) {
    return "Newsletter";
  }

  if (IMPORTANT_HINTS.some((hint) => normalized.includes(hint))) {
    return "Important";
  }

  return "Can wait";
}

export function classifyThreads(
  threads: EmailThread[],
  customBuckets: BucketName[] = []
): BucketedThreads {
  const output: BucketedThreads = {};
  const allBuckets = [...DEFAULT_BUCKETS, ...customBuckets];

  for (const bucket of allBuckets) {
    output[bucket] = [];
  }

  for (const thread of threads) {
    const primary = classifySubject(thread.subject);
    const target = output[primary] ? primary : "Can wait";
    output[target].push(thread);
  }

  return output;
}
