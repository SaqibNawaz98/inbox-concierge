import type { EmailThread } from "@/lib/types";

import { embeddingsUrl } from "@/lib/llmTransport";

export const DEFAULT_EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";

export function threadToEmbedText(thread: EmailThread): string {
  const parts = [
    `From: ${thread.sender}`,
    `Subject: ${thread.subject}`,
    `Preview: ${thread.preview}`,
  ];
  return parts.join("\n").slice(0, 8000);
}

/** One string per thread for the OpenAI embeddings API. */
export function buildThreadEmbeddingInputs(threads: EmailThread[]): string[] {
  return threads.map((thread) => threadToEmbedText(thread));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

type OpenAiEmbeddingResponse = {
  data?: Array<{ index?: number; embedding?: number[] }>;
};

export async function fetchEmbeddingsBatch(params: {
  apiKey: string;
  model: string;
  inputs: string[];
  /** OpenAI-compatible API root (…/v1); defaults to OpenAI cloud. */
  apiBase?: string;
  signal?: AbortSignal;
}): Promise<number[][]> {
  const { apiKey, model, inputs, apiBase, signal } = params;
  if (inputs.length === 0) {
    return [];
  }

  const url = embeddingsUrl(
    apiBase?.trim() || process.env.LLM_EMBEDDINGS_API_BASE?.trim() || process.env.LLM_API_BASE?.trim() || "https://api.openai.com/v1",
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: inputs }),
    signal,
  });

  if (!response.ok) {
    const snippet = (await response.text()).slice(0, 200);
    throw new Error(`embeddings_http_${response.status}:${snippet}`);
  }

  const payload = (await response.json()) as OpenAiEmbeddingResponse;
  const rows = [...(payload.data ?? [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  const out: number[][] = [];
  for (let i = 0; i < inputs.length; i += 1) {
    const emb = rows[i]?.embedding;
    if (!Array.isArray(emb) || emb.length === 0) {
      throw new Error("embeddings_missing_vector");
    }
    out.push(emb);
  }
  return out;
}
