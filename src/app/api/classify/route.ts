import { NextResponse } from "next/server";
import { accountKeyFromRefreshToken } from "@/lib/accountKey";
import { readGoogleTokensCookie } from "@/lib/authCookies";
import { MOCK_THREADS } from "@/lib/mockEmails";
import { DEFAULT_BUCKETS } from "@/lib/buckets";
import { LEARNING_OPTIONAL_SETUP_MESSAGE } from "@/lib/learningSetupMessage";
import { isLearningDatabaseConfigured } from "@/lib/learningDb";
import { classifyThreadsWithLlm } from "@/lib/llmClassify";
import { prisma } from "@/lib/prisma";
import type { BucketName, EmailThread } from "@/lib/types";

/** Long-running LLM fan-out; raise on Vercel if your plan allows (e.g. 300s). */
export const maxDuration = 300;

type RequestBody = {
  threads?: EmailThread[];
  customBuckets?: BucketName[];
  /** @deprecated use llmApiKey */
  openaiApiKey?: string;
  llmApiKey?: string;
  llmApiBase?: string;
  llmModel?: string;
  llmEmbeddingsApiBase?: string;
};

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as RequestBody;

    const threads = body.threads ?? MOCK_THREADS;
    const customBuckets = body.customBuckets ?? [];
    const llmOptions = {
      openaiApiKey:
        typeof body.openaiApiKey === "string" ? body.openaiApiKey : undefined,
      llmApiKey: typeof body.llmApiKey === "string" ? body.llmApiKey : undefined,
      llmApiBase: typeof body.llmApiBase === "string" ? body.llmApiBase : undefined,
      llmModel: typeof body.llmModel === "string" ? body.llmModel : undefined,
      llmEmbeddingsApiBase:
        typeof body.llmEmbeddingsApiBase === "string"
          ? body.llmEmbeddingsApiBase
          : undefined,
    };

    let learning:
      | { accountKey: string; prisma: typeof prisma }
      | undefined;
    if (isLearningDatabaseConfigured()) {
      const tokens = await readGoogleTokensCookie();
      if (tokens?.refresh_token) {
        learning = {
          accountKey: accountKeyFromRefreshToken(tokens.refresh_token),
          prisma,
        };
      }
    }

    const { classification, metadata } = await classifyThreadsWithLlm(
      threads,
      customBuckets,
      learning,
      llmOptions,
    );

    const learningDbAvailable = isLearningDatabaseConfigured();
    const metadataOut = {
      ...metadata,
      learningDbAvailable,
      ...(!learningDbAvailable ? { learningHint: LEARNING_OPTIONAL_SETUP_MESSAGE } : {}),
    };

    return NextResponse.json({
      defaultBuckets: DEFAULT_BUCKETS,
      customBuckets,
      classification,
      metadata: metadataOut,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Classification failed unexpectedly.";
    return NextResponse.json({ message }, { status: 500 });
  }
}
