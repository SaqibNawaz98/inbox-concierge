import type { PrismaClient } from "@prisma/client";
import {
  DEFAULT_EMBEDDING_MODEL,
  buildThreadEmbeddingInputs,
  fetchEmbeddingsBatch,
} from "@/lib/embeddings";
import { knnBucketForThread, loadTrainingRows } from "@/lib/learningKnn";
import type { BucketName, EmailThread } from "@/lib/types";

const CHUNK = 96;

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * After base assignments (LLM + rule fill), override buckets where kNN on saved examples is confident.
 */
export async function applyEmbeddingOverrides(params: {
  prisma: PrismaClient;
  accountKey: string;
  apiKey: string;
  /** OpenAI-style `/v1/embeddings` API root */
  embeddingsApiBase?: string;
  threads: EmailThread[];
  assignments: Map<string, string>;
  allowedBuckets: Set<string>;
}): Promise<{ overrides: number }> {
  const {
    prisma,
    accountKey,
    apiKey,
    embeddingsApiBase,
    threads,
    assignments,
    allowedBuckets,
  } = params;

  const minExamples = numEnv("LEARNING_MIN_EXAMPLES", 5);
  const topK = numEnv("LEARNING_TOP_K", 7);
  const minTopSim = numEnv("LEARNING_MIN_TOP_SIMILARITY", 0.8);
  const minVotes = numEnv("LEARNING_MIN_VOTES", 3);
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;

  const neighbors = await loadTrainingRows(prisma, accountKey);
  if (neighbors.length < minExamples) {
    return { overrides: 0 };
  }

  let overrides = 0;
  const inputs = buildThreadEmbeddingInputs(threads);
  const modelVectors: number[][] = [];

  for (let i = 0; i < inputs.length; i += CHUNK) {
    const slice = inputs.slice(i, i + CHUNK);
    const batch = await fetchEmbeddingsBatch({
      apiKey,
      model,
      inputs: slice,
      apiBase: embeddingsApiBase,
    });
    modelVectors.push(...batch);
  }

  for (let i = 0; i < threads.length; i += 1) {
    const thread = threads[i];
    const vec = modelVectors[i];
    if (!vec) {
      continue;
    }

    const knnBucket = knnBucketForThread({
      threadEmbedding: vec,
      neighbors,
      topK,
      minTopSimilarity: minTopSim,
      minVotes,
    });

    if (!knnBucket || !allowedBuckets.has(knnBucket)) {
      continue;
    }

    const prior = assignments.get(thread.id);
    if (prior === knnBucket) {
      continue;
    }

    assignments.set(thread.id, knnBucket as BucketName);
    overrides += 1;
  }

  return { overrides };
}
