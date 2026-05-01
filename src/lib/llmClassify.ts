import type { PrismaClient } from "@prisma/client";
import {
  buildBucketSemanticsForLlm,
  bucketUsesBillsSemantics,
  bucketUsesPostReceiptSemantics,
} from "@/lib/bucketSemantics";
import {
  normalizeActiveBucketsForClassification,
  pickNeutralFallback,
  resolveBucketToAllowed,
} from "@/lib/activeBuckets";
import { classifyThreads, inferBucketForThread } from "@/lib/classify";
import { applyEmbeddingOverrides } from "@/lib/learningApply";
import { friendlyLearningInfrastructureError } from "@/lib/learningDb";
import {
  completeLlmClassificationJson,
  resolveEmbeddingsBase,
  resolveLlmTransport,
  usedClientSuppliedKey,
  type LlmClientOverrides,
  type LlmTransportKind,
  type ResolvedLlmTransport,
} from "@/lib/llmTransport";
import type { BucketName, BucketedThreads, EmailThread } from "@/lib/types";

/**
 * Classification strategy (time vs API calls):
 * - Single request: O(1) round-trips for n ≤ OPENAI_CLASSIFY_SINGLE_SHOT_MAX (default 200).
 * - Batched parallel: O(⌈n/b⌉ / c) round-trip waves, b=batch size, c=concurrency.
 */
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_BATCH_SIZE = 80;

/** Notes that sound like hard failures but are recovered by heuristic / gap-fill retries. */
function suppressFromOpenAiIssues(note: string): boolean {
  if (note.startsWith("single_shot_low_coverage:")) {
    return true;
  }
  return (
    note.startsWith("gap_fill:openai_no_valid_assignments") ||
    note.startsWith("gap_fill:openai_json_missing_assignments") ||
    note.startsWith("gap_fill:llm_no_valid_assignments") ||
    note.startsWith("gap_fill:llm_json_missing_assignments")
  );
}

type LlmStrategy = "single_request" | "batched_parallel";

type LlmClassificationOutcome = {
  classification: BucketedThreads;
  metadata: {
    classifier: "llm-openai" | "rule-based-fallback";
    model: string;
    fallbackReason: string | null;
    batchCount: number;
    threadsClassifiedByLlm?: number;
    threadsTotal?: number;
    hybridRuleFill?: boolean;
    /** Threads labeled in extra OpenAI pass(es) after main batches (missing / bad ids). */
    threadsLlmGapFilled?: number;
    /** True when stragglers were assigned to "Can wait" instead of keyword rules. */
    remainderNeutralOnly?: boolean;
    openaiIssues?: string[];
    strategy?: LlmStrategy;
    /** kNN overrides applied after LLM / rules (requires DATABASE_URL + saved examples). */
    embeddingOverrides?: number;
    learningError?: string;
    /** True when the OpenAI key came from the classify request (browser), not only server env. */
    openaiKeyFromClient?: boolean;
    /** Which HTTP transport was used for chat completions. */
    llmTransport?: LlmTransportKind;
  };
};

export type LearningContext = {
  accountKey: string;
  prisma: PrismaClient;
};

/** Client / request overrides for provider, base URL, model, and API key. */
export type ClassifyThreadsWithLlmOptions = LlmClientOverrides;

/** When `OPENAI_CLASSIFY_RULE_GAP_FILL=false`, stragglers become `Can wait` instead of keyword rules. */
function inferOrNeutral(
  thread: EmailThread,
  allowedBuckets: BucketName[],
): BucketName {
  const norm = normalizeActiveBucketsForClassification(allowedBuckets);
  if (process.env.OPENAI_CLASSIFY_RULE_GAP_FILL === "false") {
    return pickNeutralFallback(norm) as BucketName;
  }
  return inferBucketForThread(thread, norm);
}

function bucketedToAssignments(bucketed: BucketedThreads): Map<string, string> {
  const map = new Map<string, string>();
  for (const [bucket, list] of Object.entries(bucketed)) {
    for (const thread of list) {
      map.set(thread.id, bucket);
    }
  }
  return map;
}

async function finalizeAssignmentsToBuckets(params: {
  threads: EmailThread[];
  customBuckets: BucketName[];
  allowedBuckets: string[];
  assignments: Map<string, string>;
  learning?: LearningContext;
  openaiApiKey?: string;
  /** OpenAI-style `/v1/embeddings` base (same key is used unless you split keys later). */
  embeddingsApiBase?: string;
  llmClientOverrides?: LlmClientOverrides | null;
}): Promise<{
  output: BucketedThreads;
  embeddingOverrides: number;
  learningError?: string;
}> {
  const {
    threads,
    customBuckets,
    allowedBuckets,
    assignments,
    learning,
    openaiApiKey,
    embeddingsApiBase,
    llmClientOverrides,
  } = params;

  let embeddingOverrides = 0;
  let learningError: string | undefined;

  if (
    learning &&
    openaiApiKey &&
    process.env.LEARNING_OVERRIDE_ON_CLASSIFY !== "false"
  ) {
    try {
      const result = await applyEmbeddingOverrides({
        prisma: learning.prisma,
        accountKey: learning.accountKey,
        apiKey: openaiApiKey,
        embeddingsApiBase:
          embeddingsApiBase ?? resolveEmbeddingsBase(llmClientOverrides ?? null),
        threads,
        assignments,
        allowedBuckets: new Set(allowedBuckets),
      });
      embeddingOverrides = result.overrides;
    } catch (error) {
      const raw =
        error instanceof Error ? error.message : String(error);
      learningError = friendlyLearningInfrastructureError(raw);
    }
  }

  const output = buildEmptyBuckets(allowedBuckets);
  for (const thread of threads) {
    let bucket = assignments.get(thread.id);
    if (!bucket || !output[bucket]) {
      bucket = inferOrNeutral(thread, customBuckets);
    }
    const target = resolveBucketToAllowed(bucket, allowedBuckets);
    output[target].push(thread);
  }

  return { output, embeddingOverrides, learningError };
}

type ParsedAssignments = {
  assignments?: Array<{
    id?: string;
    bucket?: string;
  }>;
};

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") {
    return fallback;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Upper bound for threads per OpenAI classify batch (input+output token tradeoff). */
function maxClassifyBatchSize(): number {
  return Math.min(200, Math.max(20, numEnv("OPENAI_CLASSIFY_MAX_BATCH_SIZE", 200)));
}

function clampBatchSize(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_BATCH_SIZE;
  }
  return Math.min(maxClassifyBatchSize(), Math.max(1, Math.floor(value)));
}

/** Parallel in-flight classify requests (respect OpenAI rate limits). */
function maxClassifyConcurrency(): number {
  return Math.min(24, Math.max(2, numEnv("OPENAI_CLASSIFY_MAX_CONCURRENCY", 12)));
}

function clampConcurrency(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return Math.min(4, maxClassifyConcurrency());
  }
  return Math.min(maxClassifyConcurrency(), Math.max(1, Math.floor(value)));
}

function batchCompletionTokenBudget(threadCount: number): number {
  const cap = Math.min(
    16384,
    numEnv("OPENAI_CLASSIFY_BATCH_MAX_COMPLETION", 8192),
  );
  return Math.min(cap, 400 + threadCount * 42);
}

function buildEmptyBuckets(buckets: string[]) {
  const output: BucketedThreads = {};
  for (const bucket of buckets) {
    output[bucket] = [];
  }
  return output;
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/** Shorter text = fewer input tokens and faster model pass (ids stay full length). */
function shrinkThreadForModel(thread: EmailThread, limits: { subject: number; preview: number; sender: number }): EmailThread {
  return {
    id: thread.id,
    subject: thread.subject.slice(0, limits.subject),
    preview: thread.preview.slice(0, limits.preview),
    sender: thread.sender.slice(0, limits.sender),
    receivedAt: thread.receivedAt,
  };
}

function stripResponseToJsonObject(raw: string) {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/im);
  if (fenceMatch?.[1]) {
    text = fenceMatch[1].trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}

function safelyParseAssignments(raw: string): ParsedAssignments {
  const candidate = stripResponseToJsonObject(raw);
  try {
    return JSON.parse(candidate) as ParsedAssignments;
  } catch {
    return {};
  }
}

/** Map model bucket strings onto allowed labels (exact, trim, then case-insensitive). */
function normalizeBucketToAllowed(
  raw: unknown,
  allowedBuckets: string[],
): string | null {
  if (raw == null) {
    return null;
  }
  const s = String(raw).trim();
  if (!s) {
    return null;
  }
  for (const b of allowedBuckets) {
    if (b === s) {
      return b;
    }
  }
  const lower = s.toLowerCase();
  for (const b of allowedBuckets) {
    if (b.toLowerCase() === lower) {
      return b;
    }
  }
  return null;
}

/** Strip quotes / ellipsis the model sometimes adds around Gmail thread ids. */
function normalizeModelThreadIdKey(raw: string): string {
  let s = String(raw).trim().replace(/^["'`]+|["'`]+$/g, "");
  while (s.endsWith("…") || s.endsWith("...")) {
    s = s.slice(0, -1).trim();
  }
  return s.trim();
}

/**
 * Remap LLM `id` strings onto real thread ids when the model truncates or slightly corrupts keys.
 * Only applies conservative matches (exact, or unique prefix extension).
 */
function repairAssignmentMap(
  raw: Map<string, string>,
  threads: EmailThread[],
): Map<string, string> {
  const idSet = new Set(threads.map((t) => t.id));
  const out = new Map<string, string>();

  for (const [rawKey, bucket] of raw) {
    const key = normalizeModelThreadIdKey(rawKey);
    if (!key) {
      continue;
    }
    if (idSet.has(key)) {
      out.set(key, bucket);
      continue;
    }
    if (key.length >= 10) {
      const byPrefix = threads.filter((t) => t.id.startsWith(key));
      if (byPrefix.length === 1) {
        out.set(byPrefix[0].id, bucket);
        continue;
      }
    }
    if (key.length >= 14) {
      const byContains = threads.filter(
        (t) => t.id.includes(key) || key.includes(t.id),
      );
      if (byContains.length === 1) {
        out.set(byContains[0].id, bucket);
      }
    }
  }
  return out;
}

async function classifyChunkWithLlm(params: {
  transport: ResolvedLlmTransport;
  allowedBuckets: string[];
  threads: EmailThread[];
  maxCompletionTokens?: number;
  timeoutMs?: number;
  bucketSemantics?: Record<string, string>;
  /** Appended to `rules` (e.g. gap-fill correction pass). */
  extraRules?: string[];
}): Promise<Map<string, string>> {
  const { transport, allowedBuckets, threads } = params;
  const threadInput = threads.map((thread) => ({
    id: thread.id,
    subject: thread.subject,
    preview: thread.preview,
    sender: thread.sender,
  }));

  const timeoutMs =
    params.timeoutMs ??
    Number(process.env.OPENAI_CLASSIFY_REQUEST_TIMEOUT_MS ?? 90_000);

  const rules = [
    "Return JSON only as an object shaped like {\"assignments\":[{\"id\":\"...\",\"bucket\":\"...\"}]} — no prose outside JSON.",
    "Use only bucket names from allowedBuckets.",
    "Include every thread id exactly once.",
    "Copy each `id` from the input exactly — Gmail ids are opaque strings; never truncate or rewrite them.",
    "Apply bucketSemantics for EVERY bucket key that appears in bucketSemantics (default + custom)—do not drift to \"Can wait\" by default.",
    "Read subject, preview, AND sender domain; LinkedIn role digests with hiring language belong in Jobs when that bucket exists.",
    ...(params.extraRules ?? []),
  ];
  const hasReceiptBucketLabel = allowedBuckets.some((label) =>
    bucketUsesPostReceiptSemantics(label),
  );
  const hasBillsBucketLabel = allowedBuckets.some((label) =>
    bucketUsesBillsSemantics(label),
  );
  if (hasReceiptBucketLabel && hasBillsBucketLabel) {
    rules.push(
      "Separate Receipt-type vs Bills-type buckets: Bills/Billing means money still owed (pay this invoice, amount due, overdue). Receipt means post-transaction proof (payment received, order shipped/delivered, thank you for purchase, receipt). Prefer Bills when unpaid language appears even if \"invoice\" is in the thread.",
    );
  }

  const semantics = params.bucketSemantics ?? {};
  if (Object.keys(semantics).length > 0) {
    rules.push(
      "If `bucketSemantics` defines a bucket label, follow that definition precisely when choosing that bucket (do not expand it to unrelated mail)."
    );
  }

  const userPayload: Record<string, unknown> = {
    task: "Classify each thread into exactly one allowed bucket.",
    allowedBuckets,
    rules,
    threads: threadInput,
  };
  if (Object.keys(semantics).length > 0) {
    userPayload.bucketSemantics = semantics;
  }

  const systemPrompt =
    "You triage Gmail threads into exactly one bucket. Reply with JSON only (one JSON object). " +
    "Use bucketSemantics for every allowed bucket name supplied—follow them strictly. " +
    "Do not put most mail in \"Can wait\": spread volume across Newsletter (bulk/promo/digests), " +
    "Auto-archive (OTP/tracking/automated pings), Jobs when that bucket exists for recruiting/job alerts, " +
    "Bills/Billing for outstanding payables, Receipts for post-payment proof and fulfillment when that bucket exists, " +
    "and Important only for real human/security attention. Prefer the most specific bucket.";

  const raw = await completeLlmClassificationJson({
    transport,
    systemPrompt,
    userJsonText: JSON.stringify(userPayload),
    maxCompletionTokens: params.maxCompletionTokens,
    timeoutMs,
  });

  const parsed = safelyParseAssignments(raw);
  const output = new Map<string, string>();

  const rows = parsed.assignments;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("openai_json_missing_assignments");
  }

  for (const assignment of rows) {
    if (!assignment?.id || !assignment?.bucket) {
      continue;
    }
    const bucket = normalizeBucketToAllowed(assignment.bucket, allowedBuckets);
    if (!bucket) {
      continue;
    }
    output.set(String(assignment.id).trim(), bucket);
  }

  const repaired = repairAssignmentMap(output, threads);
  if (repaired.size === 0) {
    throw new Error("openai_no_valid_assignments");
  }

  return repaired;
}

async function classifyGapFillChunkWithFallback(params: {
  transport: ResolvedLlmTransport;
  allowedBuckets: string[];
  bucketSemantics: Record<string, string>;
  compactChunk: EmailThread[];
}): Promise<{ updates: Array<[string, string]>; err: string | null }> {
  const { transport, allowedBuckets, bucketSemantics, compactChunk } = params;

  const run = async (threads: EmailThread[]) =>
    classifyChunkWithLlm({
      transport,
      allowedBuckets,
      threads,
      maxCompletionTokens: batchCompletionTokenBudget(threads.length),
      bucketSemantics,
      extraRules: [
        "These threads were missing or had invalid ids in an earlier labeling pass.",
        "Return exactly one assignment per input thread. Each `id` must match a thread `id` from this request exactly (full string, character-for-character).",
      ],
    });

  const picksUpdates = (
    partial: Map<string, string>,
    threads: EmailThread[],
  ): Array<[string, string]> => {
    const updates: Array<[string, string]> = [];
    for (const [id, bucket] of partial) {
      if (!threads.some((t) => t.id === id)) {
        continue;
      }
      updates.push([id, bucket]);
    }
    return updates;
  };

  try {
    const partial = await run(compactChunk);
    return { updates: picksUpdates(partial, compactChunk), err: null };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const retriable =
      (msg.includes("openai_no_valid_assignments") ||
        msg.includes("openai_json_missing_assignments") ||
        msg.includes("llm_no_valid_assignments") ||
        msg.includes("llm_json_missing_assignments")) &&
      compactChunk.length > 1;
    if (!retriable) {
      return { updates: [], err: msg.slice(0, 200) };
    }
    const updates: Array<[string, string]> = [];
    let lastErr = msg.slice(0, 200);
    for (const t of compactChunk) {
      try {
        const partial = await run([t]);
        updates.push(...picksUpdates(partial, [t]));
      } catch (e) {
        lastErr =
          e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
      }
    }
    if (updates.length > 0) {
      return { updates, err: null };
    }
    return { updates: [], err: lastErr };
  }
}

async function gapFillMissingAssignments(params: {
  missing: EmailThread[];
  assignments: Map<string, string>;
  transport: ResolvedLlmTransport;
  allowedBuckets: string[];
  bucketSemantics: Record<string, string>;
}): Promise<{ filled: number; errors: string[] }> {
  const { missing, assignments, transport, allowedBuckets, bucketSemantics } =
    params;
  if (missing.length === 0) {
    return { filled: 0, errors: [] };
  }
  const chunkCap = Math.min(
    64,
    Math.max(8, numEnv("OPENAI_CLASSIFY_GAP_FILL_CHUNK_SIZE", 40)),
  );
  const errors: string[] = [];
  let filled = 0;
  const chunks = chunkArray(missing, chunkCap);
  const gapConcurrency = Math.min(
    maxClassifyConcurrency(),
    Math.max(1, numEnv("OPENAI_CLASSIFY_GAP_FILL_CONCURRENCY", 4)),
  );

  for (let waveStart = 0; waveStart < chunks.length; waveStart += gapConcurrency) {
    const wave = chunks.slice(waveStart, waveStart + gapConcurrency);
    const waveResults = await Promise.all(
      wave.map(async (chunk) => {
        const compactChunk = chunk.map((t) =>
          shrinkThreadForModel(t, {
            subject: 220,
            preview: 220,
            sender: 120,
          }),
        );
        const { updates, err } = await classifyGapFillChunkWithFallback({
          transport,
          allowedBuckets,
          bucketSemantics,
          compactChunk,
        });
        return {
          updates: updates.filter(([id]) => chunk.some((t) => t.id === id)),
          err,
        };
      }),
    );

    for (const result of waveResults) {
      if (result.err) {
        errors.push(result.err);
      }
      for (const [id, bucket] of result.updates) {
        if (assignments.has(id)) {
          continue;
        }
        assignments.set(id, bucket);
        filled += 1;
      }
    }
  }

  return { filled, errors };
}

async function runGapFillRounds(params: {
  threads: EmailThread[];
  assignments: Map<string, string>;
  transport: ResolvedLlmTransport;
  allowedBuckets: string[];
  bucketSemantics: Record<string, string>;
  batchErrors: string[];
}): Promise<number> {
  const gapEnabled = process.env.OPENAI_CLASSIFY_GAP_FILL !== "false";
  const gapRounds = gapEnabled
    ? Math.max(0, Math.min(4, numEnv("OPENAI_CLASSIFY_GAP_FILL_ROUNDS", 2)))
    : 0;
  if (gapRounds === 0) {
    return 0;
  }

  let totalFilled = 0;
  let prevMissing = Infinity;

  for (let round = 0; round < gapRounds; round += 1) {
    const missing = params.threads.filter((t) => !params.assignments.has(t.id));
    if (missing.length === 0) {
      break;
    }
    if (missing.length >= prevMissing) {
      break;
    }
    prevMissing = missing.length;

    const { filled, errors } = await gapFillMissingAssignments({
      missing,
      assignments: params.assignments,
      transport: params.transport,
      allowedBuckets: params.allowedBuckets,
      bucketSemantics: params.bucketSemantics,
    });

    totalFilled += filled;
    for (const err of errors.slice(0, 2)) {
      params.batchErrors.push(`gap_fill:${err}`);
    }
    if (filled === 0) {
      break;
    }
  }

  return totalFilled;
}

async function applyGapFillAndHeuristicRemainder(params: {
  threads: EmailThread[];
  assignments: Map<string, string>;
  transport: ResolvedLlmTransport;
  allowedBuckets: string[];
  bucketSemantics: Record<string, string>;
  batchErrors: string[];
}): Promise<{ gapFilled: number; heuristicFilled: number }> {
  const gapFilled = await runGapFillRounds({
    threads: params.threads,
    assignments: params.assignments,
    transport: params.transport,
    allowedBuckets: params.allowedBuckets,
    bucketSemantics: params.bucketSemantics,
    batchErrors: params.batchErrors,
  });

  let heuristicFilled = 0;
  for (const thread of params.threads) {
    if (!params.assignments.has(thread.id)) {
      params.assignments.set(
        thread.id,
        inferOrNeutral(thread, params.allowedBuckets as BucketName[]),
      );
      heuristicFilled += 1;
    }
  }

  return { gapFilled, heuristicFilled };
}

function singleShotConfigured(threadsLen: number) {
  const maxN = Number(process.env.OPENAI_CLASSIFY_SINGLE_SHOT_MAX ?? 220);
  if (maxN <= 0 || threadsLen > maxN) {
    return false;
  }
  return process.env.OPENAI_CLASSIFY_SINGLE_SHOT !== "false";
}

export async function classifyThreadsWithLlm(
  threads: EmailThread[],
  customBuckets: BucketName[] = [],
  learning?: LearningContext,
  options?: ClassifyThreadsWithLlmOptions,
): Promise<LlmClassificationOutcome> {
  /** Full active bucket list (request body carries every label used for classify, not additive defaults). */
  const allowedBuckets = normalizeActiveBucketsForClassification(customBuckets);
  const transport = resolveLlmTransport(options ?? null);
  const usedClientOpenAiKey = usedClientSuppliedKey(options ?? null);

  const runFallback = async (
    reason: string,
    embeddingKey?: string,
  ): Promise<LlmClassificationOutcome> => {
    const assignments = bucketedToAssignments(
      classifyThreads(threads, allowedBuckets)
    );
    const { output, embeddingOverrides, learningError } =
      await finalizeAssignmentsToBuckets({
        threads,
        customBuckets: allowedBuckets,
        allowedBuckets,
        assignments,
        learning,
        openaiApiKey: embeddingKey,
        embeddingsApiBase: resolveEmbeddingsBase(options ?? null),
        llmClientOverrides: options ?? null,
      });
    return {
      classification: output,
      metadata: {
        classifier: "rule-based-fallback",
        model: transport?.chatModel ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
        fallbackReason: reason,
        batchCount: 0,
        embeddingOverrides,
        learningError,
        openaiKeyFromClient: usedClientOpenAiKey || undefined,
        llmTransport: transport ? "openai_compatible" : undefined,
      },
    };
  };

  if (threads.length === 0) {
    return {
      classification: buildEmptyBuckets(allowedBuckets),
      metadata: {
        classifier: "llm-openai",
        model: transport?.chatModel ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
        fallbackReason: null,
        batchCount: 0,
        strategy: "single_request",
        embeddingOverrides: 0,
        openaiKeyFromClient: usedClientOpenAiKey || undefined,
        llmTransport: transport ? "openai_compatible" : undefined,
      },
    };
  }

  if (!transport) {
    return runFallback("missing_llm_api_key");
  }

  const apiKey = transport.apiKey;
  const model = transport.chatModel;
  const bucketSemantics = buildBucketSemanticsForLlm(allowedBuckets);

  const assignments = new Map<string, string>();
  const batchErrors: string[] = [];
  let llmBatchesSucceeded = 0;
  let inferFilledCount = 0;
  let threadsLlmGapFilled = 0;
  let batchCount = 0;
  let strategy: LlmStrategy = "batched_parallel";

  const coverageThreshold = Number(
    process.env.OPENAI_CLASSIFY_SINGLE_SHOT_MIN_COVERAGE ?? 0.88
  );

  /** --- Path 1: one API call for the whole inbox (fastest asymptotically) --- */
  if (singleShotConfigured(threads.length)) {
    const limits = {
      subject: Number(process.env.OPENAI_SINGLE_SHOT_SUBJECT_LEN ?? 160),
      preview: Number(process.env.OPENAI_SINGLE_SHOT_PREVIEW_LEN ?? 140),
      sender: Number(process.env.OPENAI_SINGLE_SHOT_SENDER_LEN ?? 100),
    };
    const trimmed = threads.map((t) => shrinkThreadForModel(t, limits));

    const maxCompletionTokens = Math.min(
      16384,
      Number(process.env.OPENAI_SINGLE_SHOT_MAX_COMPLETION ?? 8192)
    );

    const singleTimeout = Number(
      process.env.OPENAI_CLASSIFY_SINGLE_SHOT_TIMEOUT_MS ?? 210_000
    );

    try {
      const partial = await classifyChunkWithLlm({
        transport,
        allowedBuckets,
        threads: trimmed,
        maxCompletionTokens,
        timeoutMs: singleTimeout,
        bucketSemantics,
      });

      const minNeed = Math.ceil(threads.length * coverageThreshold);
      if (partial.size >= minNeed) {
        for (const [id, bucket] of partial.entries()) {
          assignments.set(id, bucket);
        }
        llmBatchesSucceeded = 1;
        batchCount = 1;
        strategy = "single_request";
      } else {
        batchErrors.push(
          `single_shot_low_coverage:${partial.size}/${threads.length}`
        );
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : String(error);
      batchErrors.push(`single_shot:${detail}`);
    }
  }

  /** --- Path 2: parallel mini-batches (fallback or when single-shot disabled) --- */
  if (strategy !== "single_request") {
    assignments.clear();
    llmBatchesSucceeded = 0;
    inferFilledCount = 0;

    const batchSize = clampBatchSize(
      Number(process.env.OPENAI_CLASSIFY_BATCH_SIZE ?? DEFAULT_BATCH_SIZE)
    );
    const threadChunks = chunkArray(threads, batchSize);
    const concurrency = clampConcurrency(
      Number(process.env.OPENAI_CLASSIFY_CONCURRENCY ?? 6)
    );
    batchCount = threadChunks.length;

    for (let waveStart = 0; waveStart < threadChunks.length; waveStart += concurrency) {
      const wave = threadChunks.slice(waveStart, waveStart + concurrency);
      const waveOutcomes = await Promise.all(
        wave.map(async (chunk) => {
          const compactChunk = chunk.map((t) =>
            shrinkThreadForModel(t, {
              subject: 200,
              preview: 200,
              sender: 120,
            })
          );
          try {
            const partialAssignments = await classifyChunkWithLlm({
              transport,
              allowedBuckets,
              threads: compactChunk,
              maxCompletionTokens: batchCompletionTokenBudget(compactChunk.length),
              bucketSemantics,
            });
            return { ok: true as const, partialAssignments, chunk };
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error);
            return { ok: false as const, detail, chunk };
          }
        })
      );

      for (const outcome of waveOutcomes) {
        if (outcome.ok) {
          for (const [id, bucket] of outcome.partialAssignments.entries()) {
            assignments.set(id, bucket);
          }
          llmBatchesSucceeded += 1;
        } else {
          batchErrors.push(outcome.detail);
        }
      }
    }

    if (llmBatchesSucceeded === 0) {
      return runFallback(
        batchErrors.join(" | ") || "llm_failed:no_successful_batches",
        apiKey
      );
    }

    const batchedRemainder = await applyGapFillAndHeuristicRemainder({
      threads,
      assignments,
      transport,
      allowedBuckets,
      bucketSemantics,
      batchErrors,
    });
    threadsLlmGapFilled += batchedRemainder.gapFilled;
    inferFilledCount += batchedRemainder.heuristicFilled;
  } else {
    const singleRemainder = await applyGapFillAndHeuristicRemainder({
      threads,
      assignments,
      transport,
      allowedBuckets,
      bucketSemantics,
      batchErrors,
    });
    threadsLlmGapFilled += singleRemainder.gapFilled;
    inferFilledCount += singleRemainder.heuristicFilled;
  }

  const { output, embeddingOverrides, learningError } =
    await finalizeAssignmentsToBuckets({
      threads,
      customBuckets: allowedBuckets,
      allowedBuckets,
      assignments,
      learning,
      openaiApiKey: apiKey,
      embeddingsApiBase: resolveEmbeddingsBase(options ?? null),
      llmClientOverrides: options ?? null,
    });

  /** Omit notes that downstream recovery already handled so the UI stays accurate. */
  const openaiIssuesRaw =
    batchErrors.length > 0
      ? [...new Set(batchErrors)].filter((item) => !suppressFromOpenAiIssues(item))
      : [];
  const openaiIssues =
    openaiIssuesRaw.length > 0
      ? openaiIssuesRaw.slice(0, 4).map((item) => item.slice(0, 220))
      : undefined;

  return {
    classification: output,
    metadata: {
      classifier: "llm-openai",
      model,
      fallbackReason: null,
      batchCount,
      threadsTotal: threads.length,
      threadsClassifiedByLlm: Math.max(0, threads.length - inferFilledCount),
      hybridRuleFill: inferFilledCount > 0,
      threadsLlmGapFilled: threadsLlmGapFilled > 0 ? threadsLlmGapFilled : undefined,
      remainderNeutralOnly:
        inferFilledCount > 0 &&
        process.env.OPENAI_CLASSIFY_RULE_GAP_FILL === "false"
          ? true
          : undefined,
      openaiIssues,
      strategy,
      embeddingOverrides,
      learningError,
      openaiKeyFromClient: usedClientOpenAiKey || undefined,
      llmTransport: "openai_compatible",
    },
  };
}
