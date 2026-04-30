import { NextResponse } from "next/server";
import { classifyThreads } from "@/lib/classify";
import { MOCK_THREADS } from "@/lib/mockEmails";
import type { BucketName, EmailThread } from "@/lib/types";

type RequestBody = {
  customBuckets: BucketName[];
  threads?: EmailThread[];
};

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as RequestBody;
  const customBuckets = body.customBuckets ?? [];
  const threads = body.threads ?? MOCK_THREADS;

  const classification = classifyThreads(threads, customBuckets);

  return NextResponse.json({
    customBuckets,
    classification,
  });
}
