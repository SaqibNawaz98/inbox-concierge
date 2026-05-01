/**
 * OpenAI-compatible HTTP transport: `/v1/chat/completions` and `/v1/embeddings`
 * (OpenAI, Azure OpenAI, Groq, OpenRouter, Ollama with OpenAI shim, etc.).
 */

const DEFAULT_OPENAI_V1 = "https://api.openai.com/v1";

/** Metadata only — all chat uses OpenAI-style APIs. */
export type LlmTransportKind = "openai_compatible";

export type LlmClientOverrides = {
  llmApiKey?: string | null;
  /** @deprecated use llmApiKey */
  openaiApiKey?: string | null;
  /** OpenAI-compatible API root (…/v1), e.g. https://api.openai.com/v1 */
  llmApiBase?: string | null;
  llmModel?: string | null;
  /** Override only for `/v1/embeddings` (defaults to LLM_EMBEDDINGS_API_BASE or llmApiBase). */
  llmEmbeddingsApiBase?: string | null;
};

export type ResolvedLlmTransport = {
  apiKey: string;
  chatModel: string;
  /** API root ending in …/v1 (chat + default embeddings). */
  openAiCompatibleBase: string;
  /** When false, omit `response_format` (local / some proxies). */
  useJsonResponseFormat: boolean;
};

const CLIENT_LLM_KEY_MAX_LEN = 512;

function trimKey(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (s.length === 0 || s.length > CLIENT_LLM_KEY_MAX_LEN) {
    return "";
  }
  return s;
}

function pickApiKey(overrides?: LlmClientOverrides | null): string {
  const fromClient = trimKey(overrides?.llmApiKey ?? overrides?.openaiApiKey);
  if (fromClient) {
    return fromClient;
  }
  return process.env.LLM_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || "";
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** Ensure base is like https://host/.../v1 without trailing slash. */
function normalizeOpenAiStyleBase(raw: string | undefined | null): string {
  const fallback = process.env.LLM_API_BASE?.trim() || DEFAULT_OPENAI_V1;
  const s = stripTrailingSlash((raw ?? "").trim() || fallback);
  if (!/^https?:\/\//i.test(s)) {
    return stripTrailingSlash(fallback);
  }
  return s;
}

export function usedClientSuppliedKey(overrides?: LlmClientOverrides | null): boolean {
  return Boolean(trimKey(overrides?.llmApiKey ?? overrides?.openaiApiKey));
}

function envBool(name: string, defaultValue: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no") {
    return false;
  }
  if (v === "true" || v === "1" || v === "yes") {
    return true;
  }
  return defaultValue;
}

export function resolveLlmTransport(
  overrides?: LlmClientOverrides | null,
): ResolvedLlmTransport | null {
  const apiKey = pickApiKey(overrides);
  if (!apiKey) {
    return null;
  }

  const chatModel =
    overrides?.llmModel?.trim() ||
    process.env.LLM_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-4o-mini";

  const openAiCompatibleBase = normalizeOpenAiStyleBase(overrides?.llmApiBase);

  return {
    apiKey,
    chatModel,
    openAiCompatibleBase,
    useJsonResponseFormat: envBool("LLM_JSON_MODE", true),
  };
}

export function chatCompletionsUrl(openAiCompatibleBase: string): string {
  return `${stripTrailingSlash(openAiCompatibleBase)}/chat/completions`;
}

export function embeddingsUrl(openAiCompatibleBase: string): string {
  return `${stripTrailingSlash(openAiCompatibleBase)}/embeddings`;
}

async function readHttpErrorSnippet(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as {
      error?: { message?: string; type?: string; code?: string };
      message?: string;
    };
    const msg =
      payload.error?.message ??
      payload.message ??
      payload.error?.type ??
      payload.error?.code;
    if (msg) {
      return String(msg).slice(0, 280);
    }
  } catch {
    try {
      return (await response.text()).slice(0, 200);
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * One classification call: system + user JSON string → model output text (expected JSON object).
 */
export async function completeLlmClassificationJson(params: {
  transport: ResolvedLlmTransport;
  systemPrompt: string;
  userJsonText: string;
  maxCompletionTokens?: number;
  timeoutMs: number;
}): Promise<string> {
  const { transport, systemPrompt, userJsonText, maxCompletionTokens, timeoutMs } = params;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = chatCompletionsUrl(transport.openAiCompatibleBase);
    const body: Record<string, unknown> = {
      model: transport.chatModel,
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userJsonText },
      ],
    };
    if (transport.useJsonResponseFormat) {
      body.response_format = { type: "json_object" };
    }
    if (maxCompletionTokens != null) {
      body.max_completion_tokens = maxCompletionTokens;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${transport.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const snippet = await readHttpErrorSnippet(response);
      throw new Error(
        snippet
          ? `llm_http_${response.status}:${snippet}`
          : `llm_http_${response.status}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    const raw = payload.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) {
      throw new Error("llm_empty_message_content");
    }
    return raw;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Embeddings API root (OpenAI-style only). */
export function resolveEmbeddingsBase(overrides?: {
  llmEmbeddingsApiBase?: string | null;
  llmApiBase?: string | null;
} | null): string {
  const fromClient = overrides?.llmEmbeddingsApiBase?.trim();
  const fromClientShared = overrides?.llmApiBase?.trim();
  return normalizeOpenAiStyleBase(
    fromClient ||
      fromClientShared ||
      process.env.LLM_EMBEDDINGS_API_BASE?.trim() ||
      process.env.LLM_API_BASE?.trim() ||
      null,
  );
}
