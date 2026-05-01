import type { PrismaClient } from "@prisma/client";
import { cosineSimilarity } from "@/lib/embeddings";
import type { BucketName } from "@/lib/types";

export type TrainingRow = {
  gmailThreadId: string;
  bucket: string;
  embedding: number[];
};

function parseEmbedding(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const nums = raw.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return nums.length === raw.length ? nums : null;
}

export async function loadTrainingRows(
  prisma: PrismaClient,
  accountKey: string,
  limit = 4000
): Promise<TrainingRow[]> {
  const rows = await prisma.mailTrainingExample.findMany({
    where: { accountKey },
    select: {
      gmailThreadId: true,
      bucket: true,
      embedding: true,
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  const out: TrainingRow[] = [];
  for (const row of rows) {
    const emb = parseEmbedding(row.embedding);
    if (emb) {
      out.push({
        gmailThreadId: row.gmailThreadId,
        bucket: row.bucket,
        embedding: emb,
      });
    }
  }
  return out;
}

/**
 * kNN vote among top neighbors. Returns null if confidence is too low.
 */
export function knnBucketForThread(params: {
  threadEmbedding: number[];
  neighbors: TrainingRow[];
  topK: number;
  minTopSimilarity: number;
  minVotes: number;
}): BucketName | null {
  const { threadEmbedding, neighbors, topK, minTopSimilarity, minVotes } = params;
  if (neighbors.length === 0) {
    return null;
  }

  const scored = neighbors
    .map((n) => ({
      bucket: n.bucket,
      sim: cosineSimilarity(threadEmbedding, n.embedding),
    }))
    .sort((a, b) => b.sim - a.sim);

  if (scored.length === 0 || scored[0].sim < minTopSimilarity) {
    return null;
  }

  const slice = scored.slice(0, topK);
  const counts = new Map<string, { count: number; bestSim: number }>();
  for (const item of slice) {
    const prev = counts.get(item.bucket);
    if (!prev) {
      counts.set(item.bucket, { count: 1, bestSim: item.sim });
    } else {
      counts.set(item.bucket, {
        count: prev.count + 1,
        bestSim: Math.max(prev.bestSim, item.sim),
      });
    }
  }

  let winner: string | null = null;
  let best = { count: 0, bestSim: 0 };
  for (const [bucket, stats] of counts) {
    if (
      stats.count > best.count ||
      (stats.count === best.count && stats.bestSim > best.bestSim)
    ) {
      winner = bucket;
      best = stats;
    }
  }

  if (!winner || best.count < minVotes) {
    return null;
  }

  return winner;
}
