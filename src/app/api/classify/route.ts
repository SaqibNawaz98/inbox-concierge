import { NextResponse } from "next/server";
import { classifyThreads } from "@/lib/classify";
import { MOCK_THREADS } from "@/lib/mockEmails";
import { DEFAULT_BUCKETS } from "@/lib/buckets";
import type { BucketName, EmailThread } from "@/lib/types";

type RequestBody = {
  threads?: EmailThread[];
  customBuckets?: BucketName[];
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as RequestBody;

  const threads = body.threads ?? MOCK_THREADS;
  const customBuckets = body.customBuckets ?? [];
  const classification = classifyThreads(threads, customBuckets);

  return NextResponse.json({
    defaultBuckets: DEFAULT_BUCKETS,
    customBuckets,
    classification,
    metadata: {
      classifier: "rule-based-skeleton",
      note: "Swap in LLM classifier pipeline for production.",
    },
  });
}
