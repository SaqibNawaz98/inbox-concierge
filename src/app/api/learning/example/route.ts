import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { accountKeyFromRefreshToken } from "@/lib/accountKey";
import { readGoogleTokensCookie } from "@/lib/authCookies";
import {
  DEFAULT_EMBEDDING_MODEL,
  fetchEmbeddingsBatch,
  threadToEmbedText,
} from "@/lib/embeddings";
import {
  friendlyLearningInfrastructureError,
  isLearningDatabaseConfigured,
} from "@/lib/learningDb";
import { LEARNING_OPTIONAL_SETUP_MESSAGE } from "@/lib/learningSetupMessage";
import { resolveEmbeddingsBase, type LlmClientOverrides } from "@/lib/llmTransport";
import { prisma } from "@/lib/prisma";
import type { BucketName, EmailThread } from "@/lib/types";

type Body = {
  thread?: EmailThread;
  bucket?: BucketName;
  /** @deprecated use llmApiKey */
  openaiApiKey?: string;
  llmApiKey?: string;
  llmApiBase?: string;
  llmEmbeddingsApiBase?: string;
};

export async function POST(request: Request) {
  if (!isLearningDatabaseConfigured()) {
    return NextResponse.json(
      {
        message: LEARNING_OPTIONAL_SETUP_MESSAGE,
        code: "learning_requires_database",
      },
      { status: 503 }
    );
  }

  const tokens = await readGoogleTokensCookie();
  if (!tokens?.refresh_token) {
    return NextResponse.json({ message: "Not signed in to Google." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as Body;
  const thread = body.thread;
  const bucket = body.bucket?.trim();
  if (!thread?.id || !bucket) {
    return NextResponse.json(
      { message: "Provide thread { id, subject, preview, sender, receivedAt } and bucket." },
      { status: 400 }
    );
  }

  const fromBodyRaw =
    (typeof body.llmApiKey === "string" ? body.llmApiKey.trim() : "") ||
    (typeof body.openaiApiKey === "string" ? body.openaiApiKey.trim() : "");
  const fromBody =
    fromBodyRaw.length > 0 && fromBodyRaw.length <= 512 ? fromBodyRaw : "";
  const apiKey =
    fromBody ||
    process.env.LLM_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "";
  const llmOverrides: LlmClientOverrides = {
    llmApiBase: typeof body.llmApiBase === "string" ? body.llmApiBase : undefined,
    llmEmbeddingsApiBase:
      typeof body.llmEmbeddingsApiBase === "string"
        ? body.llmEmbeddingsApiBase
        : undefined,
  };
  const embeddingsApiBase = resolveEmbeddingsBase(llmOverrides);
  if (!apiKey) {
    return NextResponse.json(
      {
        message:
          "OpenAI API key required for embeddings: set LLM_API_KEY or OPENAI_API_KEY on the server, or add your key via the settings gear in the app.",
      },
      { status: 503 }
    );
  }

  const accountKey = accountKeyFromRefreshToken(tokens.refresh_token);
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const text = threadToEmbedText(thread);

  let embedding: number[][];
  try {
    embedding = await fetchEmbeddingsBatch({
      apiKey,
      model,
      inputs: [text],
      apiBase: embeddingsApiBase,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Embedding request failed.";
    return NextResponse.json({ message }, { status: 502 });
  }

  const vector = embedding[0];
  if (!vector?.length) {
    return NextResponse.json({ message: "Empty embedding response." }, { status: 502 });
  }

  try {
    await prisma.mailTrainingExample.upsert({
      where: {
        accountKey_gmailThreadId: {
          accountKey,
          gmailThreadId: thread.id,
        },
      },
      create: {
        accountKey,
        gmailThreadId: thread.id,
        bucket,
        subject: thread.subject ?? "",
        preview: thread.preview ?? "",
        sender: thread.sender ?? "",
        embedding: vector,
        embeddingModel: model,
      },
      update: {
        bucket,
        subject: thread.subject ?? "",
        preview: thread.preview ?? "",
        sender: thread.sender ?? "",
        embedding: vector,
        embeddingModel: model,
      },
    });
  } catch (error) {
    const original =
      error instanceof Error ? error.message : "Unknown database error.";
    const isMissingTable =
      /does not exist|relation.*mailtrainingexample/i.test(original) ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2021");
    const isConnect =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P1001" || error.code === "P1000");

    let message = friendlyLearningInfrastructureError(original).slice(0, 220);
    if (isMissingTable) {
      message =
        "Learning table is missing. From the project root run: npx prisma migrate deploy";
    } else if (isConnect) {
      message =
        "Could not reach Postgres (check DATABASE_URL and that the database is running).";
    }

    return NextResponse.json(
      { message, code: "learning_db_error" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
