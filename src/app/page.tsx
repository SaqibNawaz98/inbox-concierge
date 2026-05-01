"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DEFAULT_BUCKETS } from "@/lib/buckets";
import {
  DEFAULT_GMAIL_MAX_THREADS,
  INBOX_THREAD_PRESETS,
} from "@/lib/gmailInboxLimits";
import {
  flattenBucketSelection,
  normalizeActiveBucketsForClassification,
  splitStoredBucketList,
  TRIAGE_BUCKET_LIST_FV,
  triageBucketsFromBlob,
} from "@/lib/activeBuckets";
import { LEARNING_OPTIONAL_SETUP_MESSAGE } from "@/lib/learningSetupMessage";
import type { BucketedThreads, BucketName, EmailThread } from "@/lib/types";

const apiFetch: typeof fetch = (input, init) =>
  fetch(input, { credentials: "include", cache: "no-store", ...init });

type LoadGmailThreadsOptions = {
  autoClassify?: boolean;
  customBucketsForAutoClassify?: string[];
};

type ClassifyMetadata = {
  classifier?: string;
  model?: string;
  fallbackReason?: string | null;
  batchCount?: number;
  hybridRuleFill?: boolean;
  threadsLlmGapFilled?: number;
  remainderNeutralOnly?: boolean;
  threadsClassifiedByLlm?: number;
  threadsTotal?: number;
  openaiIssues?: string[];
  strategy?: "single_request" | "batched_parallel";
  embeddingOverrides?: number;
  learningError?: string;
  /** Present when `DATABASE_URL` is unset — learning APIs are skipped. */
  learningHint?: string;
  openaiKeyFromClient?: boolean;
  llmTransport?: string;
  /** From server: Postgres configured for learning / saved examples. */
  learningDbAvailable?: boolean;
};

const TRIAGE_SESSION_KEY = "inbox-concierge-triage-v1";
const RESTORE_STATUS_PREFIX = "Restored ·";
/** OAuth return success copy; shown briefly as a top toast. */
const SIGN_IN_SUCCESS_PREFIX = "Signed in successfully";
/** Learning example saved; centered dialog instead of inline banner. */
const LEARNING_SAVED_CONFIRM_PREFIX = "Saved as a training example";
const LLM_PREFS_STORAGE_KEY = "inbox_concierge_llm_prefs";
const LEGACY_CLIENT_OPENAI_KEY = "inbox_concierge_client_openai_key";
const LLM_MODEL_ID_MAX_LEN = 128;

const CHAT_MODEL_PRESETS: { id: string; label: string }[] = [
  { id: "", label: "App default (gpt-4o-mini)" },
  { id: "gpt-4o-mini", label: "gpt-4o-mini" },
  { id: "gpt-4o", label: "gpt-4o" },
  { id: "gpt-4.1-mini", label: "gpt-4.1-mini" },
  { id: "gpt-4.1", label: "gpt-4.1" },
  { id: "gpt-4-turbo", label: "gpt-4-turbo" },
  { id: "gpt-3.5-turbo", label: "gpt-3.5-turbo" },
];

type ClientLlmPrefs = {
  apiKey?: string;
  model?: string;
};

function normalizeStoredModel(raw: string | undefined): string | undefined {
  const t = (raw ?? "").trim();
  if (!t || t.length > LLM_MODEL_ID_MAX_LEN) {
    return undefined;
  }
  return t;
}

function readClientLlmPrefs(): ClientLlmPrefs {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = sessionStorage.getItem(LLM_PREFS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (!parsed || typeof parsed !== "object") {
        return {};
      }
      const rawKey = typeof parsed.apiKey === "string" ? parsed.apiKey : "";
      const apiKey = rawKey.trim();
      const model = normalizeStoredModel(
        typeof parsed.model === "string" ? parsed.model : undefined,
      );
      const out: ClientLlmPrefs = {};
      if (apiKey) {
        out.apiKey = apiKey;
      }
      if (model) {
        out.model = model;
      }
      return out;
    }
    const legacy = sessionStorage.getItem(LEGACY_CLIENT_OPENAI_KEY);
    if (legacy?.trim()) {
      const prefs: ClientLlmPrefs = { apiKey: legacy.trim() };
      sessionStorage.setItem(LLM_PREFS_STORAGE_KEY, JSON.stringify(prefs));
      sessionStorage.removeItem(LEGACY_CLIENT_OPENAI_KEY);
      return prefs;
    }
  } catch {
    return {};
  }
  return {};
}

function persistClientLlmPrefs(prefs: ClientLlmPrefs) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const key = prefs.apiKey?.trim();
    const model = normalizeStoredModel(prefs.model);
    if (!key && !model) {
      sessionStorage.removeItem(LLM_PREFS_STORAGE_KEY);
      return;
    }
    const payload: Record<string, string> = {};
    if (key) {
      payload.apiKey = key;
    }
    if (model) {
      payload.model = model;
    }
    sessionStorage.setItem(LLM_PREFS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

/** Clears triage session + browser-stored LLM key (used on sign out). */
function clearAllClientSecrets() {
  if (typeof window === "undefined") {
    return;
  }
  try {
    sessionStorage.removeItem(TRIAGE_SESSION_KEY);
    sessionStorage.removeItem(LLM_PREFS_STORAGE_KEY);
    sessionStorage.removeItem(LEGACY_CLIENT_OPENAI_KEY);
  } catch {
    // ignore
  }
}

function clientPrefsToLlmRequestBody(prefs: ClientLlmPrefs): Record<string, string> {
  const body: Record<string, string> = {};
  if (prefs.apiKey?.trim()) {
    body.llmApiKey = prefs.apiKey.trim();
  }
  const model = normalizeStoredModel(prefs.model);
  if (model) {
    body.llmModel = model;
  }
  return body;
}

/** Masked view so you can tell which secret is in use (never shows the full key). */
const KEY_MASK_RUN = 10;

function formatKeyInUse(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) {
    return null;
  }
  if (t.length <= 4) {
    return "············ (saved)";
  }
  const tail = t.slice(-4);
  const mask = ".".repeat(KEY_MASK_RUN);
  const lower = t.toLowerCase();
  if (lower.startsWith("sk-proj-")) {
    return `sk-proj-${mask}${tail}`;
  }
  if (lower.startsWith("sk-")) {
    return `sk-${mask}${tail}`;
  }
  if (t.length <= 12) {
    return `${t.slice(0, 2)}${mask}${tail}`;
  }
  return `${t.slice(0, 4)}${mask}${tail}`;
}

type TriageSessionBlob = {
  v: 1;
  threads: EmailThread[];
  bucketedThreads: BucketedThreads;
  inboxGeneration: number;
  classifiedGeneration: number | null;
  classifiedBucketFingerprint: string | null;
  customBuckets: string[];
  classifyMeta: ClassifyMetadata | null;
  bucketListFv?: typeof TRIAGE_BUCKET_LIST_FV;
};

function bucketedHasThreads(bt: BucketedThreads): boolean {
  return Object.values(bt).some((list) => Array.isArray(list) && list.length > 0);
}

function readTriageSession(): TriageSessionBlob | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = sessionStorage.getItem(TRIAGE_SESSION_KEY);
    if (!raw) {
      return null;
    }
    const blob = JSON.parse(raw) as TriageSessionBlob;
    if (blob.v !== 1 || !Array.isArray(blob.threads) || blob.threads.length === 0) {
      return null;
    }
    if (!blob.bucketedThreads || typeof blob.bucketedThreads !== "object") {
      return null;
    }
    return blob;
  } catch {
    return null;
  }
}

function writeTriageSession(blob: TriageSessionBlob) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    sessionStorage.setItem(TRIAGE_SESSION_KEY, JSON.stringify(blob));
  } catch {
    // QuotaExceededError on very large inboxes — skip silently
  }
}

function bucketsFingerprint(buckets: string[]): string {
  return [...buckets]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
    .join("\u0001");
}

function parseBucketInputs(raw: string): string[] {
  return raw
    .split(/[,;\n]+/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function mergeUnique(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing);
  const next = [...existing];
  for (const item of additions) {
    if (!seen.has(item)) {
      seen.add(item);
      next.push(item);
    }
  }
  return next;
}

function nameCollidesWithPreset(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  return DEFAULT_BUCKETS.some((d) => d.toLowerCase() === t);
}

function compactThreadsForClassify(threads: EmailThread[]): EmailThread[] {
  return threads.map((thread) => ({
    ...thread,
    subject: thread.subject.slice(0, 600),
    preview: thread.preview.slice(0, 400),
  }));
}

function bucketAccent(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return {
    borderLeftColor: `hsl(${hue} 42% 52%)`,
    background: `linear-gradient(135deg, hsl(${hue} 35% 97%) 0%, white 55%)`,
  };
}

function InboxIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 6a2 2 0 012-2h12a2 2 0 012 2v0a2 2 0 01-.9 1.67l-7 4.67a2 2 0 01-2.2 0l-7-4.67A2 2 0 014 6v0z" />
      <path d="M22 10v8a2 2 0 01-2 2H4a2 2 0 01-2-2v-8" />
      <path d="M12 12v5" />
    </svg>
  );
}

function SettingsGearIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
    </svg>
  );
}

export default function Home() {
  const [customBucketInput, setCustomBucketInput] = useState("");
  /** Preset buckets the user hid (canonical names matching DEFAULT_BUCKETS). */
  const [excludedPresetKeys, setExcludedPresetKeys] = useState<BucketName[]>([]);
  /** User-created bucket names only (never the four preset labels). */
  const [extraBuckets, setExtraBuckets] = useState<string[]>([]);
  const [threads, setThreads] = useState<EmailThread[] | null>(null);
  const [inboxGeneration, setInboxGeneration] = useState(0);
  const [classifiedGeneration, setClassifiedGeneration] = useState<number | null>(
    null
  );
  const [classifiedBucketFingerprint, setClassifiedBucketFingerprint] = useState<
    string | null
  >(null);

  const [bucketedThreads, setBucketedThreads] = useState<BucketedThreads>({});
  const [status, setStatus] = useState("Idle");
  const [oauthMessage, setOauthMessage] = useState("");
  const [classifyNotice, setClassifyNotice] = useState("");
  /** Shown between hero and bucket grid while /api/classify is in flight. */
  const [classifyProgressBanner, setClassifyProgressBanner] = useState<{
    startedAt: number;
    threadCount: number;
  } | null>(null);
  const [classifyProgressSec, setClassifyProgressSec] = useState(0);
  const [isConnected, setIsConnected] = useState(false);
  const [classifyMeta, setClassifyMeta] = useState<ClassifyMetadata | null>(null);
  const [learningMessage, setLearningMessage] = useState("");
  /** null = not loaded yet from /api/learning/status or classify metadata. */
  const [learningDbAvailable, setLearningDbAvailable] = useState<boolean | null>(null);
  const [savingExampleId, setSavingExampleId] = useState<string | null>(null);
  const [inboxLoadLimit, setInboxLoadLimit] = useState(200);
  const [inboxMaxCap, setInboxMaxCap] = useState(DEFAULT_GMAIL_MAX_THREADS);
  const [bucketsPersistEnabled, setBucketsPersistEnabled] = useState(false);
  const [bucketsSaveHint, setBucketsSaveHint] = useState("");
  /**
   * Saved OpenAI key (sessionStorage). Never bound to the settings input — the field is only
   * for entering a new or replacement key; use "Done" to save.
   */
  const [clientLlmSavedKey, setClientLlmSavedKey] = useState<string | undefined>(undefined);
  const [clientLlmSavedModel, setClientLlmSavedModel] = useState<string | undefined>(undefined);
  const [llmSettingsKeyDraft, setLlmSettingsKeyDraft] = useState("");
  const [llmSettingsModelDraft, setLlmSettingsModelDraft] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const lastPersistedFingerprint = useRef<string | null>(null);
  const loadBucketsAbortRef = useRef<AbortController | null>(null);
  const persistTriageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settingsApiKeyInputRef = useRef<HTMLInputElement>(null);
  const inboxGenerationRef = useRef(0);
  const loadGmailThreadsRef = useRef<
    (options?: LoadGmailThreadsOptions) => Promise<EmailThread[] | null>
  >(async () => null);

  const chatModelPresetIds = useMemo(
    () => new Set(CHAT_MODEL_PRESETS.map((row) => row.id)),
    [],
  );
  const settingsModelSelectValue =
    llmSettingsModelDraft === "" || chatModelPresetIds.has(llmSettingsModelDraft)
      ? llmSettingsModelDraft
      : "__custom__";

  const inboxLimitOptions = useMemo(() => {
    const fromPresets = INBOX_THREAD_PRESETS.filter((n) => n <= inboxMaxCap);
    const seed =
      fromPresets.length > 0 ? fromPresets : [Math.max(1, Math.min(200, inboxMaxCap))];
    const merged = new Set(seed);
    if (inboxMaxCap >= 1) {
      merged.add(inboxMaxCap);
    }
    merged.add(Math.min(inboxLoadLimit, inboxMaxCap));
    return [...merged].sort((a, b) => a - b);
  }, [inboxMaxCap, inboxLoadLimit]);

  const bucketNames = useMemo(() => Object.keys(bucketedThreads), [bucketedThreads]);
  const effectiveBuckets = useMemo(
    () => flattenBucketSelection(excludedPresetKeys, extraBuckets),
    [excludedPresetKeys, extraBuckets],
  );
  const activeBucketsFingerprint = useMemo(
    () => bucketsFingerprint(effectiveBuckets),
    [effectiveBuckets],
  );

  const learningDbResolved = useMemo(() => {
    if (typeof classifyMeta?.learningDbAvailable === "boolean") {
      return classifyMeta.learningDbAvailable;
    }
    return learningDbAvailable;
  }, [classifyMeta?.learningDbAvailable, learningDbAvailable]);

  const classificationStale = useMemo(() => {
    if (!threads?.length) {
      return false;
    }
    if (classifiedGeneration === null) {
      return true;
    }
    if (classifiedGeneration !== inboxGeneration) {
      return true;
    }
    return classifiedBucketFingerprint !== activeBucketsFingerprint;
  }, [
    threads?.length,
    classifiedGeneration,
    inboxGeneration,
    classifiedBucketFingerprint,
    activeBucketsFingerprint,
  ]);

  const isBusy =
    status.startsWith("Loading") ||
    status.startsWith("Fetching") ||
    status.startsWith("Classifying");

  useEffect(() => {
    if (!classifyProgressBanner) {
      setClassifyProgressSec(0);
      return;
    }
    const label = (sec: number) =>
      `Classifying… ${sec}s · ${classifyProgressBanner.threadCount} threads — model is sorting (large inboxes may take ~2–3 min)`;
    const tick = () => {
      const sec = Math.floor((Date.now() - classifyProgressBanner.startedAt) / 1000);
      setClassifyProgressSec(sec);
      setStatus(label(sec));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [classifyProgressBanner]);

  const loadBucketsFromAccount = useCallback(async (): Promise<string[]> => {
    loadBucketsAbortRef.current?.abort();
    const controller = new AbortController();
    loadBucketsAbortRef.current = controller;
    setBucketsPersistEnabled(false);
    setBucketsSaveHint("");
    try {
      const res = await apiFetch("/api/buckets/saved", { signal: controller.signal });
      if (!res.ok) {
        setBucketsPersistEnabled(true);
        return [];
      }
      const data = await res.json();
      const rawList = Array.isArray(data.buckets)
        ? data.buckets.filter((x: unknown): x is string => typeof x === "string")
        : [];
      if (controller.signal.aborted) {
        return [];
      }
      const listMerged = normalizeActiveBucketsForClassification(rawList);
      const { excludedPresets, extras } = splitStoredBucketList(listMerged);
      const excludedSortedLocal = [...new Set(excludedPresets)].sort() as BucketName[];
      setExcludedPresetKeys(excludedSortedLocal);
      setExtraBuckets(extras);
      const eff = flattenBucketSelection(excludedSortedLocal, extras);
      lastPersistedFingerprint.current = bucketsFingerprint(eff);
      setBucketsPersistEnabled(true);
      return eff;
    } catch {
      if (!controller.signal.aborted) {
        setBucketsPersistEnabled(true);
      }
      return [];
    }
  }, []);

  useEffect(() => {
    // sessionStorage is unavailable on SSR; defer read to avoid hydration mismatch + lint cascade.
    queueMicrotask(() => {
      const prefs = readClientLlmPrefs();
      setClientLlmSavedKey(prefs.apiKey?.trim() || undefined);
      setClientLlmSavedModel(prefs.model);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiFetch("/api/learning/status");
        const data = (await res.json()) as { available?: boolean };
        if (!cancelled) {
          setLearningDbAvailable(data.available === true);
        }
      } catch {
        if (!cancelled) {
          setLearningDbAvailable(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    inboxGenerationRef.current = inboxGeneration;
  }, [inboxGeneration]);

  const openLlmSettings = useCallback(() => {
    setLlmSettingsKeyDraft("");
    setLlmSettingsModelDraft(clientLlmSavedModel ?? "");
    setSettingsOpen(true);
  }, [clientLlmSavedModel]);

  const closeLlmSettings = useCallback(() => {
    setLlmSettingsKeyDraft("");
    setLlmSettingsModelDraft(clientLlmSavedModel ?? "");
    setSettingsOpen(false);
  }, [clientLlmSavedModel]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeLlmSettings();
      }
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [settingsOpen, closeLlmSettings]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }
    const id = window.requestAnimationFrame(() => {
      settingsApiKeyInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(id);
  }, [settingsOpen]);

  useEffect(() => {
    if (!isConnected) {
      loadBucketsAbortRef.current?.abort();
    }
  }, [isConnected]);

  useEffect(() => {
    if (typeof window === "undefined" || threads === null) {
      return;
    }
    if (persistTriageTimerRef.current) {
      clearTimeout(persistTriageTimerRef.current);
    }
    persistTriageTimerRef.current = setTimeout(() => {
      persistTriageTimerRef.current = null;
      writeTriageSession({
        v: 1,
        threads,
        bucketedThreads,
        inboxGeneration,
        classifiedGeneration,
        classifiedBucketFingerprint,
        customBuckets: effectiveBuckets,
        bucketListFv: TRIAGE_BUCKET_LIST_FV,
        classifyMeta,
      });
    }, 400);
    return () => {
      if (persistTriageTimerRef.current) {
        clearTimeout(persistTriageTimerRef.current);
        persistTriageTimerRef.current = null;
      }
    };
  }, [
    threads,
    bucketedThreads,
    inboxGeneration,
    classifiedGeneration,
    classifiedBucketFingerprint,
    effectiveBuckets,
    classifyMeta,
  ]);

  useEffect(() => {
    if (!isConnected || !bucketsPersistEnabled) {
      return;
    }
    const fp = bucketsFingerprint(effectiveBuckets);
    if (fp === lastPersistedFingerprint.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const res = await apiFetch("/api/buckets/saved", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ buckets: effectiveBuckets }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setBucketsSaveHint(
              typeof payload.message === "string"
                ? payload.message
                : `Save failed (${res.status})`,
            );
            return;
          }
          lastPersistedFingerprint.current = bucketsFingerprint(effectiveBuckets);
          setBucketsSaveHint("Saved to your account");
          window.setTimeout(() => setBucketsSaveHint(""), 2200);
        } catch {
          setBucketsSaveHint("Network error while saving buckets.");
        }
      })();
    }, 750);
    return () => window.clearTimeout(timer);
  }, [effectiveBuckets, isConnected, bucketsPersistEnabled]);

  useEffect(() => {
    if (!oauthMessage.startsWith(SIGN_IN_SUCCESS_PREFIX)) {
      return;
    }
    const hide = window.setTimeout(() => {
      setOauthMessage("");
    }, 4200);
    return () => window.clearTimeout(hide);
  }, [oauthMessage]);

  useEffect(() => {
    if (!learningMessage.startsWith(LEARNING_SAVED_CONFIRM_PREFIX)) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLearningMessage("");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const hide = window.setTimeout(() => {
      setLearningMessage("");
    }, 5200);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(hide);
    };
  }, [learningMessage]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const sessionResponse = await apiFetch("/api/auth/session");
      const sessionData = await sessionResponse.json();
      let connected = Boolean(sessionData.connected);

      const url =
        typeof window !== "undefined" ? new URL(window.location.href) : null;
      const authStatus = url?.searchParams.get("auth") ?? null;
      const authReason = url?.searchParams.get("reason") ?? null;

      if (authStatus === "success") {
        try {
          sessionStorage.removeItem(TRIAGE_SESSION_KEY);
        } catch {
          /* ignore */
        }
        setOauthMessage(`${SIGN_IN_SUCCESS_PREFIX}. You're ready to triage Gmail.`);
        connected = true;
      } else if (authStatus === "error") {
        setOauthMessage(`Sign-in didn't finish: ${authReason ?? "unknown_error"}`);
      }

      if (url && (authStatus === "success" || authStatus === "error")) {
        url.searchParams.delete("auth");
        url.searchParams.delete("reason");
        const qs = url.searchParams.toString();
        const nextPath = qs ? `${url.pathname}?${qs}` : url.pathname;
        window.history.replaceState({}, "", nextPath);
      }

      setIsConnected(connected);
      if (!connected || cancelled) {
        return;
      }

      const blob = readTriageSession();
      if (blob) {
        setThreads(blob.threads);
        setBucketedThreads(blob.bucketedThreads);
        setInboxGeneration(blob.inboxGeneration);
        inboxGenerationRef.current = blob.inboxGeneration;
        setClassifiedGeneration(blob.classifiedGeneration);
        setClassifiedBucketFingerprint(blob.classifiedBucketFingerprint);
        setClassifyMeta(blob.classifyMeta);
        const restoredMerged = triageBucketsFromBlob(
          blob.customBuckets ?? [],
          blob.bucketListFv,
        );
        const restoredSplit = splitStoredBucketList(restoredMerged);
        const excludedSorted = [...new Set(restoredSplit.excludedPresets)].sort(
        ) as BucketName[];
        setExcludedPresetKeys(excludedSorted);
        setExtraBuckets(restoredSplit.extras);
        lastPersistedFingerprint.current = bucketsFingerprint(
          flattenBucketSelection(excludedSorted, restoredSplit.extras),
        );
        setBucketsPersistEnabled(true);
        const hasSort =
          blob.classifiedGeneration != null &&
          blob.classifiedGeneration === blob.inboxGeneration &&
          bucketedHasThreads(blob.bucketedThreads);
        setStatus(
          hasSort
            ? `${RESTORE_STATUS_PREFIX} ${blob.threads.length} threads and sorts (this browser tab)`
            : `${RESTORE_STATUS_PREFIX} ${blob.threads.length} threads — run classification when ready`
        );
        return;
      }

      await loadBucketsFromAccount();
      if (cancelled) {
        return;
      }
      // Do not auto-run classification here: users need a chance to open settings and
      // paste an API key (or rely on server env) before paying for / waiting on LLM.
      await loadGmailThreadsRef.current();
    })();

    return () => {
      cancelled = true;
    };
  }, [loadBucketsFromAccount]);

  async function loadGmailThreads(
    options?: LoadGmailThreadsOptions,
  ): Promise<EmailThread[] | null> {
    setClassifyNotice("");
    setStatus(
      `Fetching inbox… (up to ${inboxLoadLimit} threads — larger loads can take several minutes)`
    );

    const timeoutMs = Math.min(900_000, 60_000 + inboxLoadLimit * 400);
    const loadSignal =
      typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(timeoutMs)
        : undefined;

    let emailResponse: Response;
    try {
      emailResponse = await apiFetch(
        `/api/emails?limit=${encodeURIComponent(String(inboxLoadLimit))}`,
        { signal: loadSignal }
      );
    } catch (error) {
      setStatus("Failed");
      const aborted =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.message.includes("aborted"));
      setOauthMessage(
        aborted
          ? `Inbox load timed out (${Math.round(timeoutMs / 60_000)} min budget). Try fewer threads or run locally with a longer timeout.`
          : "Could not reach the server while loading Gmail."
      );
      setClassifyMeta(null);
      return null;
    }

    const emailData = await emailResponse.json().catch(() => ({}));

    if (!emailResponse.ok) {
      setStatus("Failed");
      setOauthMessage(
        typeof emailData.message === "string"
          ? emailData.message
          : "Could not load Gmail threads. Sign in with Google first."
      );
      setClassifyMeta(null);
      return null;
    }

    const cap =
      typeof emailData.maxAllowed === "number" && Number.isFinite(emailData.maxAllowed)
        ? emailData.maxAllowed
        : inboxMaxCap;
    setInboxMaxCap(cap);
    setInboxLoadLimit((previous) => (previous > cap ? cap : previous));

    const loaded = (emailData.threads ?? []) as EmailThread[];
    const requested =
      typeof emailData.requestedLimit === "number" ? emailData.requestedLimit : inboxLoadLimit;

    setThreads(loaded);
    setBucketedThreads({});
    setClassifyMeta(null);
    let nextGenForClassify = 0;
    setInboxGeneration((value) => {
      const next = value + 1;
      nextGenForClassify = next;
      inboxGenerationRef.current = next;
      return next;
    });

    if (!loaded.length) {
      setStatus("Inbox loaded · no threads returned");
      return loaded;
    }

    if (loaded.length < requested) {
      setStatus(
        `Inbox loaded · ${loaded.length} threads (fewer than ${requested} — no more in this view)`
      );
    } else if (!options?.autoClassify) {
      setStatus(`Inbox loaded · ${loaded.length} threads — run classification when ready`);
    }

    if (options?.autoClassify && loaded.length > 0) {
      await runClassification({
        threadsOverride: loaded,
        inboxGenerationAtRun: nextGenForClassify,
        customBucketsOverride: options.customBucketsForAutoClassify,
      });
    }

    return loaded;
  }

  loadGmailThreadsRef.current = loadGmailThreads;

  type ClassifyRunOptions = {
    threadsOverride?: EmailThread[];
    inboxGenerationAtRun?: number;
    customBucketsOverride?: string[];
  };

  async function runClassification(options?: ClassifyRunOptions) {
    const sourceThreads = options?.threadsOverride ?? threads;
    if (!sourceThreads?.length) {
      setClassifyNotice("Load your Gmail inbox first, then run classification.");
      return;
    }

    const genAtRun = options?.inboxGenerationAtRun ?? inboxGeneration;
    const bucketsForRequest = options?.customBucketsOverride ?? effectiveBuckets;
    const fingerprintAtRun = bucketsFingerprint(bucketsForRequest);
    const payloadThreads = compactThreadsForClassify(sourceThreads);

    setClassifyNotice("");
    setClassifyProgressBanner({
      startedAt: Date.now(),
      threadCount: payloadThreads.length,
    });
    setStatus(
      `Classifying… 0s · ${payloadThreads.length} threads — model is sorting (large inboxes may take ~2–3 min)`
    );

    const classifyAbort =
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function"
        ? AbortSignal.timeout(900_000)
        : undefined;

    let response: Response;
    try {
      response = await apiFetch("/api/classify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customBuckets: bucketsForRequest,
          threads: payloadThreads,
          ...clientPrefsToLlmRequestBody({
            apiKey: clientLlmSavedKey,
            model: clientLlmSavedModel,
          }),
        }),
        ...(classifyAbort ? { signal: classifyAbort } : {}),
      });
    } catch (error) {
      setClassifyProgressBanner(null);
      setStatus("Classification failed");
      const message =
        error instanceof Error ? error.message : "Classification request aborted or failed.";
      setClassifyNotice(
        message.includes("aborted") || message.includes("TimeoutError")
          ? "Classification timed out or was aborted. Try again, or reduce thread count."
          : message
      );
      setBucketedThreads({});
      setClassifyMeta(null);
      return;
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setClassifyProgressBanner(null);
      setStatus("Classification failed");
      setClassifyNotice(
        typeof data.message === "string"
          ? data.message
          : "Classification request failed. Check the server logs and your API key."
      );
      setBucketedThreads({});
      setClassifyMeta(null);
      return;
    }

    setBucketedThreads((data.classification ?? {}) as BucketedThreads);
    setClassifyMeta((data.metadata as ClassifyMetadata) ?? null);
    setClassifiedGeneration(genAtRun);
    setClassifiedBucketFingerprint(fingerprintAtRun);

    const meta = data.metadata as ClassifyMetadata | undefined;
    let notice = "";
    if (meta?.classifier === "rule-based-fallback" && meta?.fallbackReason) {
      notice =
        meta.fallbackReason === "missing_openai_api_key" ||
        meta.fallbackReason === "missing_llm_api_key"
          ? "No LLM API key — using rules only. Add your API key in settings (gear, top right), or set LLM_API_KEY / OPENAI_API_KEY on the server."
          : `Using rules fallback (${meta.model ?? "model unknown"}): ${meta.fallbackReason}`;
    } else if (meta?.openaiIssues?.length) {
      notice = `Some OpenAI batches failed: ${meta.openaiIssues.join(" · ")}`;
    } else if (meta?.hybridRuleFill) {
      const total = meta.threadsTotal;
      const byLlm = meta.threadsClassifiedByLlm;
      const gap = meta.threadsLlmGapFilled;
      notice =
        total != null && byLlm != null
          ? gap != null && gap > 0
            ? `Model labeled ${byLlm}/${total} threads (${gap} in a follow-up pass for missed or mis-keyed ids).`
            : `Model labeled ${byLlm}/${total} threads.`
          : "LLM returned partial labels; rules filled the gaps.";
    }
    if (meta?.embeddingOverrides != null && meta.embeddingOverrides > 0) {
      notice = notice
        ? `${notice} · Saved examples (embeddings) overrode ${meta.embeddingOverrides} assignment(s).`
        : `Saved examples (embeddings) overrode ${meta.embeddingOverrides} assignment(s).`;
    }
    if (meta?.learningError) {
      notice = notice
        ? `${notice} · Learning: ${meta.learningError}`
        : `Learning: ${meta.learningError}`;
    }
    if (meta?.learningHint?.trim()) {
      notice = notice
        ? `${notice} · ${meta.learningHint.trim()}`
        : meta.learningHint.trim();
    }
    if (notice) {
      setClassifyNotice(notice);
    }

    setClassifyProgressBanner(null);
    setStatus(`Done · classified ${sourceThreads.length} threads`);
  }

  async function saveTrainingExample(thread: EmailThread, bucket: string) {
    setLearningMessage("");
    setSavingExampleId(thread.id);
    try {
      const response = await apiFetch("/api/learning/example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          thread,
          bucket,
          ...clientPrefsToLlmRequestBody({
            apiKey: clientLlmSavedKey,
            model: clientLlmSavedModel,
          }),
        }),
      });
      const rawText = await response.text();
      let payload: { message?: string; code?: string } = {};
      try {
        payload = rawText ? (JSON.parse(rawText) as typeof payload) : {};
      } catch {
        payload = {};
      }
      if (!response.ok) {
        const fromApi =
          typeof payload.message === "string" && payload.message.trim()
            ? payload.message
            : null;
        setLearningMessage(
          fromApi ??
            `Save failed (HTTP ${response.status}). ${rawText.slice(0, 120)}`.trim()
        );
        return;
      }
      setLearningMessage("Saved as a training example for your account. Run classification again to apply kNN overrides.");
    } catch {
      setLearningMessage("Network error while saving the example.");
    } finally {
      setSavingExampleId(null);
    }
  }

  async function handleConnectGoogle() {
    setOauthMessage("");
    setClassifyNotice("");
    const response = await apiFetch("/api/auth/google/url");
    const data = await response.json();

    if (!response.ok) {
      setOauthMessage(
        data.message ??
          "Google sign-in is not configured yet. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI."
      );
      return;
    }

    window.location.href = data.authUrl;
  }

  async function handleDisconnect() {
    setOauthMessage("");
    setClassifyNotice("");
    try {
      const res = await apiFetch("/api/auth/disconnect", { method: "POST" });
      if (!res.ok) {
        setOauthMessage("Could not sign out on the server. Try again.");
        return;
      }
    } catch {
      setOauthMessage("Network error while signing out.");
      return;
    }
    clearAllClientSecrets();
    setIsConnected(false);
    setThreads(null);
    setBucketedThreads({});
    setClassifyMeta(null);
    setClassifiedGeneration(null);
    setClassifiedBucketFingerprint(null);
    setInboxGeneration(0);
    inboxGenerationRef.current = 0;
    setExcludedPresetKeys([]);
    setExtraBuckets([]);
    setCustomBucketInput("");
    setLearningMessage("");
    setClientLlmSavedKey(undefined);
    setClientLlmSavedModel(undefined);
    lastPersistedFingerprint.current = null;
    setBucketsPersistEnabled(false);
    setBucketsSaveHint("");
    setStatus("Signed out");
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }

  function handleExcludePreset(presetName: BucketName) {
    if (!DEFAULT_BUCKETS.includes(presetName)) {
      return;
    }
    const nextExcluded = [...new Set([...excludedPresetKeys, presetName])].sort();
    const presetsLeft = DEFAULT_BUCKETS.filter((b) => !nextExcluded.includes(b));
    if (extraBuckets.length === 0 && presetsLeft.length === 0) {
      return;
    }

    setExcludedPresetKeys(nextExcluded);
  }

  function handleIncludePreset(presetName: BucketName) {
    if (!DEFAULT_BUCKETS.includes(presetName)) {
      return;
    }
    setExcludedPresetKeys((prev) => prev.filter((x) => x !== presetName));
  }

  function handleRemoveExtraBucket(label: string) {
    const nextExtras = extraBuckets.filter((x) => x !== label);
    const presetsVisible = DEFAULT_BUCKETS.filter((b) => !excludedPresetKeys.includes(b));
    if (presetsVisible.length === 0 && nextExtras.length === 0) {
      return;
    }
    setExtraBuckets(nextExtras);
  }

  function handleAddBuckets(event: FormEvent) {
    event.preventDefault();
    const additions = parseBucketInputs(customBucketInput).filter(
      (a) => !nameCollidesWithPreset(a),
    );
    if (additions.length === 0) {
      setCustomBucketInput("");
      return;
    }

    const prevEffective = flattenBucketSelection(excludedPresetKeys, extraBuckets);
    const nextExtras = mergeUnique(extraBuckets, additions);
    const nextEffective = flattenBucketSelection(excludedPresetKeys, nextExtras);
    if (bucketsFingerprint(nextEffective) === bucketsFingerprint(prevEffective)) {
      setCustomBucketInput("");
      return;
    }

    setExtraBuckets(nextExtras);
    setCustomBucketInput("");
  }

  function handleBucketChipDismiss(label: string) {
    if (DEFAULT_BUCKETS.includes(label as BucketName)) {
      handleExcludePreset(label as BucketName);
    } else {
      handleRemoveExtraBucket(label);
    }
  }

  const runClassificationHighlighted =
    Boolean(threads?.length) && classificationStale && !isBusy;

  const inboxLoaded = threads !== null;

  const showSignInSuccessToast =
    Boolean(oauthMessage) && oauthMessage.startsWith(SIGN_IN_SUCCESS_PREFIX);

  const showLearningSavedDialog =
    Boolean(learningMessage) &&
    learningMessage.startsWith(LEARNING_SAVED_CONFIRM_PREFIX);

  return (
    <main className="relative min-h-screen overflow-hidden text-zinc-900">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_120%_80%_at_50%_-20%,rgba(99,102,241,0.16),transparent),radial-gradient(ellipse_80%_50%_at_100%_40%,rgba(14,165,233,0.1),transparent),radial-gradient(ellipse_55%_45%_at_0%_100%,rgba(244,114,182,0.07),transparent)]"
      />
      {showSignInSuccessToast ? (
        <div
          className="fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-4"
          role="status"
          aria-live="polite"
        >
          <div className="flex max-w-md items-center gap-2.5 rounded-b-2xl border border-emerald-200/90 bg-emerald-50/95 px-4 py-3 shadow-lg shadow-emerald-900/10 ring-1 ring-white/70 backdrop-blur-md sm:gap-3 sm:px-5">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.25}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </span>
            <p className="text-sm font-medium leading-snug text-emerald-950">{oauthMessage}</p>
          </div>
        </div>
      ) : null}
      {showLearningSavedDialog ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-zinc-900/40 p-4 backdrop-blur-[3px]"
          role="presentation"
          onClick={() => setLearningMessage("")}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="learning-saved-dialog-title"
            className="max-w-md rounded-2xl border border-emerald-200/90 bg-emerald-50 px-6 py-6 shadow-2xl shadow-emerald-950/20 ring-1 ring-white/90"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700">
              <svg
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p
              id="learning-saved-dialog-title"
              className="text-center text-sm font-medium leading-relaxed text-emerald-950"
            >
              {learningMessage}
            </p>
            <button
              type="button"
              className="mt-5 w-full rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md shadow-emerald-900/20 transition hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
              onClick={() => setLearningMessage("")}
            >
              Got it
            </button>
          </div>
        </div>
      ) : null}
      <span className="fixed right-4 top-4 z-40 sm:right-6 sm:top-6">
        <button
          type="button"
          onClick={openLlmSettings}
          className="relative flex h-11 w-11 items-center justify-center rounded-full border border-zinc-200/90 bg-white/90 text-zinc-700 shadow-md shadow-zinc-200/40 ring-1 ring-white/80 backdrop-blur-md transition hover:border-zinc-300 hover:bg-white hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
          aria-label={
            clientLlmSavedKey?.trim()
              ? `Open settings (key in use: ${formatKeyInUse(clientLlmSavedKey) ?? ""})`
              : "Open settings"
          }
        >
          {clientLlmSavedKey?.trim() ? (
            <span
              className="absolute right-2 top-2 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-white"
              aria-hidden
              title={`Saved Key: ${formatKeyInUse(clientLlmSavedKey) ?? ""}`}
            />
          ) : null}
          <SettingsGearIcon className="h-5 w-5" />
        </button>
      </span>

      <div className="relative mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:px-6 lg:px-8">
        <header className="rounded-2xl border border-zinc-200/70 bg-white/85 p-6 shadow-xl shadow-zinc-200/35 ring-1 ring-white/70 backdrop-blur-md sm:p-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-12 lg:items-center lg:gap-10 xl:gap-12">
            <div className="min-w-0 space-y-6 lg:col-span-7">
              <div className="max-w-2xl space-y-3">
                <h1 className="text-balance bg-gradient-to-r from-indigo-600 via-violet-600 to-indigo-600 bg-clip-text text-3xl font-semibold tracking-tight text-transparent sm:text-4xl">
                  Inbox Concierge
                </h1>
              </div>

              <div
                id="custom-buckets"
                className="rounded-2xl border border-zinc-200/70 bg-zinc-50/40 p-4 shadow-inner shadow-zinc-100/50 sm:p-5"
              >
                <div className="space-y-1">
                  <h2 className="text-base font-semibold text-zinc-950">Buckets</h2>
                  <p className="text-xs leading-relaxed text-zinc-500">
                    All four presets stay listed here—active presets have × (off); dimmed presets are off
                    and use + to turn them back on. Custom buckets are separate below.
                  </p>
                </div>
                <div className="mt-4">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                    Presets
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {DEFAULT_BUCKETS.map((bucket) => {
                      const excluded = excludedPresetKeys.includes(bucket);
                      if (!excluded) {
                        return (
                          <span
                            key={bucket}
                            className="group inline-flex items-center gap-1 rounded-full border border-emerald-200/85 bg-gradient-to-br from-emerald-50 to-white px-3.5 py-1.5 text-xs font-medium text-emerald-950 shadow-sm"
                          >
                            {bucket}
                            <button
                              type="button"
                              aria-label={`Hide preset ${bucket} from classification`}
                              onClick={() => handleExcludePreset(bucket)}
                              className="-mr-0.5 flex h-6 w-6 items-center justify-center rounded-full text-emerald-600 transition hover:bg-emerald-100 hover:text-emerald-900"
                            >
                              <span className="text-base leading-none">×</span>
                            </button>
                          </span>
                        );
                      }
                      return (
                        <span
                          key={`${bucket}-off`}
                          className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-zinc-300/90 bg-white/70 px-3.5 py-1.5 text-xs font-medium text-zinc-500"
                        >
                          <span>{bucket}</span>
                          <span className="text-[10px] font-normal uppercase tracking-wide text-zinc-400">
                            off
                          </span>
                          <button
                            type="button"
                            aria-label={`Restore preset ${bucket}`}
                            onClick={() => handleIncludePreset(bucket)}
                            className="-mr-0.5 flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
                          >
                            <span className="text-base font-semibold leading-none" aria-hidden>
                              +
                            </span>
                          </button>
                        </span>
                      );
                    })}
                  </div>
                </div>
                <p className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                  Custom buckets
                </p>
                <form
                  onSubmit={handleAddBuckets}
                  className="flex flex-col gap-3 sm:flex-row sm:items-stretch"
                >
                  <input
                    value={customBucketInput}
                    onChange={(event) => setCustomBucketInput(event.target.value)}
                    placeholder="e.g. Jobs, Receipts, Follow up this week"
                    className="min-h-11 w-full flex-1 rounded-xl border border-zinc-200/90 bg-white px-4 py-2.5 text-sm text-zinc-900 shadow-inner shadow-zinc-100/80 placeholder:text-zinc-400 transition focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/25"
                  />
                  <button
                    type="submit"
                    disabled={isBusy}
                    className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl bg-zinc-900 px-6 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-900 sm:px-8"
                  >
                    Add custom buckets
                  </button>
                </form>
                {bucketsSaveHint ? (
                  <p
                    className={`mt-3 text-xs font-medium ${
                      bucketsSaveHint.startsWith("Saved")
                        ? "text-emerald-700"
                        : bucketsSaveHint === "Saving…"
                          ? "text-zinc-600"
                          : "text-rose-700"
                    }`}
                    role="status"
                  >
                    {bucketsSaveHint}
                  </p>
                ) : null}
                {inboxLoaded && threads?.length && classificationStale && (
                  <p className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-200/85 bg-amber-50/95 px-3.5 py-2.5 text-xs font-medium leading-snug text-amber-950">
                    <span
                      aria-hidden
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-amber-400 shadow-sm shadow-amber-300/80"
                    />
                    <span>
                      Buckets or inbox changed since the last run — use{" "}
                      <strong className="font-semibold text-amber-900">Run classification</strong>
                      {classifiedGeneration === null ? "." : " to refresh labels."}
                    </span>
                  </p>
                )}
                {!classificationStale &&
                inboxLoaded &&
                threads?.length &&
                classifiedGeneration !== null ? (
                  <p className="mt-4 flex items-start gap-2.5 rounded-xl border border-emerald-200/80 bg-emerald-50/90 px-3.5 py-2.5 text-xs font-medium leading-snug text-emerald-950">
                    <span
                      aria-hidden
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-sm shadow-emerald-300/80"
                    />
                    <span>Labels match this inbox load and bucket list.</span>
                  </p>
                ) : null}
                {extraBuckets.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {extraBuckets.map((bucket) => (
                      <span
                        key={bucket}
                        className="group inline-flex items-center gap-1 rounded-full border border-indigo-200/80 bg-gradient-to-br from-indigo-50 to-white px-3.5 py-1.5 text-xs font-medium text-indigo-950 shadow-sm"
                      >
                        {bucket}
                        <button
                          type="button"
                          aria-label={`Remove ${bucket}`}
                          onClick={() => handleBucketChipDismiss(bucket)}
                          className="-mr-0.5 flex h-6 w-6 items-center justify-center rounded-full text-indigo-500 transition hover:bg-indigo-100 hover:text-indigo-800"
                        >
                          <span className="text-base leading-none">×</span>
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-3 lg:col-span-5 lg:sticky lg:top-6">
              <span
                className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                  isConnected
                    ? "border-emerald-200/90 bg-emerald-50/90 text-emerald-900"
                    : "border-zinc-200 bg-white text-zinc-600"
                }`}
                role="status"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${isConnected ? "bg-emerald-500" : "bg-zinc-400"}`}
                />
                {isConnected ? "Gmail connected" : "Gmail not connected"}
              </span>
              <div className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-md shadow-zinc-200/20 sm:p-5">
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={handleConnectGoogle}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-3 text-sm font-semibold text-white shadow-md shadow-indigo-500/25 transition hover:from-indigo-500 hover:to-violet-500 hover:shadow-lg hover:shadow-indigo-500/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
                  >
                    <svg className="h-4 w-4 opacity-90" viewBox="0 0 24 24" aria-hidden>
                      <path
                        fill="currentColor"
                        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                      />
                      <path
                        fill="currentColor"
                        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      />
                      <path
                        fill="currentColor"
                        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      />
                      <path
                        fill="currentColor"
                        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      />
                    </svg>
                    {isConnected ? "Switch Google account" : "Sign in with Google"}
                  </button>
                  {isConnected ? (
                    <button
                      type="button"
                      onClick={() => void handleDisconnect()}
                      disabled={isBusy}
                      className="rounded-xl border border-zinc-200/90 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400"
                    >
                      Sign out
                    </button>
                  ) : null}
                  <div className="flex overflow-hidden rounded-xl border border-zinc-200/90 bg-zinc-50/50 shadow-sm ring-1 ring-zinc-100/80">
                    <label className="sr-only" htmlFor="inbox-limit">
                      Number of threads to fetch
                    </label>
                    <select
                      id="inbox-limit"
                      aria-label="Number of threads to load"
                      value={Math.min(inboxLoadLimit, inboxMaxCap)}
                      disabled={isBusy}
                      onChange={(event) => setInboxLoadLimit(Number(event.target.value))}
                      className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent py-3 pl-3.5 pr-8 text-sm font-medium text-zinc-900 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-400/40 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {inboxLimitOptions.map((n) => (
                        <option key={n} value={n}>
                          {n.toLocaleString()} threads
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void loadGmailThreads()}
                      disabled={isBusy}
                      className="shrink-0 border-l border-zinc-200/90 bg-white px-4 py-3 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-500"
                    >
                      Load inbox
                    </button>
                  </div>
                  <button
                    id="run-classification"
                    type="button"
                    onClick={() => void runClassification()}
                    disabled={isBusy || !threads?.length}
                    aria-busy={isBusy}
                    className={`inline-flex w-full items-center justify-center rounded-xl px-5 py-3 text-sm font-semibold shadow-md transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none ${
                      runClassificationHighlighted
                        ? "motion-safe:animate-pulse bg-amber-500 text-amber-950 shadow-amber-500/20 ring-2 ring-amber-300/80 ring-offset-2 ring-offset-white hover:bg-amber-400 hover:animate-none focus-visible:ring-amber-400"
                        : "border border-indigo-200/90 bg-gradient-to-b from-indigo-50 to-indigo-100/80 text-indigo-950 shadow-indigo-200/40 hover:border-indigo-300 hover:from-indigo-50 hover:to-indigo-50 focus-visible:outline-indigo-500"
                    }`}
                  >
                    Run classification
                  </button>
                </div>
              </div>
            </div>
          </div>
          {oauthMessage && !oauthMessage.startsWith(SIGN_IN_SUCCESS_PREFIX) ? (
            <div
              className="mt-5 rounded-xl border border-amber-200/90 bg-amber-50/90 px-4 py-3 text-sm text-amber-950"
              role="status"
            >
              {oauthMessage}
            </div>
          ) : null}
          {classifyNotice ? (
            <div
              className={`mt-3 rounded-xl border px-4 py-3 text-sm ${
                classifyNotice.includes("Learning is optional:")
                  ? "border-sky-200/90 bg-sky-50/90 text-sky-950"
                  : classifyNotice.startsWith("Using rules fallback") ||
                      classifyNotice.startsWith("Some OpenAI") ||
                      classifyNotice.startsWith("LLM labeled")
                    ? "border-indigo-200/90 bg-indigo-50/90 text-indigo-950"
                    : "border-rose-200/90 bg-rose-50/90 text-rose-950"
              }`}
              role="status"
            >
              {classifyNotice}
            </div>
          ) : null}
          {learningMessage &&
          !learningMessage.startsWith(LEARNING_SAVED_CONFIRM_PREFIX) ? (
            <div
              className={`mt-3 rounded-xl border px-4 py-3 text-sm ${
                /DATABASE_URL|Learning is off|learning table is missing|could not reach postgres/i.test(
                  learningMessage
                )
                  ? "border-sky-200/90 bg-sky-50/90 text-sky-950"
                  : "border-rose-200/90 bg-rose-50/90 text-rose-950"
              }`}
              role="status"
            >
              {learningMessage}
            </div>
          ) : null}
        </header>

        <div
          className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs text-zinc-600"
          role="status"
          aria-live="polite"
        >
          <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-zinc-200/90 bg-white px-2.5 py-1 font-medium text-zinc-700">
            {classifyProgressBanner ? (
              <>
                <span className="h-3 w-3 shrink-0 motion-safe:animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
                <span className="min-w-0 truncate">
                  Classifying…{" "}
                  <span className="tabular-nums">{classifyProgressSec}s</span>
                  {" · "}
                  <span className="tabular-nums">{classifyProgressBanner.threadCount}</span>
                  {" threads — model is sorting (large inboxes may take ~2–3 min)"}
                </span>
              </>
            ) : (
              <>
                {isBusy ? (
                  <span className="h-3 w-3 shrink-0 motion-safe:animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-600" />
                ) : (
                  <span className="h-3 w-3 shrink-0 rounded-full bg-zinc-200" />
                )}
                <span className="min-w-0 truncate">{status}</span>
              </>
            )}
          </span>
        </div>

        <section className="grid gap-5 md:grid-cols-2">
          {bucketNames.length === 0 ? (
            <div className="md:col-span-2">
              <div className="flex flex-col items-stretch gap-5 rounded-2xl border border-dashed border-zinc-300/80 bg-white/70 px-5 py-8 shadow-inner shadow-zinc-100/50 backdrop-blur-sm sm:flex-row sm:items-center sm:gap-8 sm:px-8 sm:py-7">
                <div className="flex shrink-0 justify-center sm:justify-start">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-100 to-violet-100 text-indigo-600 shadow-md shadow-indigo-200/40 ring-1 ring-white/80 sm:h-16 sm:w-16">
                    <InboxIcon className="h-7 w-7 sm:h-8 sm:w-8" />
                  </div>
                </div>
                <div className="min-w-0 flex-1 text-center sm:text-left">
                  <p className="text-base font-semibold text-zinc-800">
                    {!threads?.length ? "Get Started" : "Ready to sort"}
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-500">
                    {!threads?.length ? (
                      <>
                        Link Gmail with Google sign-in. Add an OpenAI API key under settings. Use Load inbox
                        to fetch or change the thread count. After adding or removing bucket labels, rerun
                        classification on the threads you have loaded.
                      </>
                    ) : (
                      <>
                        Threads are in this session. Adjust buckets on the left if needed, then{" "}
                        <strong className="font-semibold text-zinc-700">Run classification</strong>.
                      </>
                    )}
                  </p>
                </div>
              </div>
            </div>
          ) : (
            bucketNames.map((bucketName) => {
              const accent = bucketAccent(bucketName);
              const count = bucketedThreads[bucketName]?.length ?? 0;
              return (
                <article
                  key={bucketName}
                  style={accent}
                  className="flex max-h-[min(28rem,55vh)] flex-col overflow-hidden rounded-2xl border border-zinc-200/90 bg-white shadow-lg shadow-zinc-200/30 ring-1 ring-white/50"
                >
                  <div className="flex items-center justify-between gap-2 border-b border-zinc-100/90 bg-gradient-to-b from-white to-zinc-50/40 px-4 py-3.5 backdrop-blur-sm">
                    <h3 className="min-w-0 truncate text-sm font-semibold text-zinc-900">
                      {bucketName}
                    </h3>
                    <span className="shrink-0 rounded-full bg-zinc-100 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-zinc-600">
                      {count}
                    </span>
                  </div>
                  <ul className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3.5">
                    {(bucketedThreads[bucketName] ?? []).map((thread) => (
                      <li
                        key={thread.id}
                        className="rounded-xl border border-zinc-100/90 bg-white/95 px-4 py-3.5 shadow-sm ring-1 ring-transparent transition hover:border-zinc-200 hover:shadow-md hover:ring-zinc-100/80"
                      >
                        <p className="line-clamp-2 text-sm font-medium leading-snug text-zinc-900">
                          {thread.subject || "(No subject)"}
                        </p>
                        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-zinc-500">
                          {thread.preview || "—"}
                        </p>
                        <p className="mt-2 truncate text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                          {thread.sender}
                        </p>
                        <div className="mt-2 flex items-center justify-end gap-2 border-t border-zinc-100/80 pt-2">
                          <button
                            type="button"
                            disabled={
                              savingExampleId === thread.id || learningDbResolved !== true
                            }
                            onClick={() => void saveTrainingExample(thread, bucketName)}
                            className="rounded-lg border border-indigo-200 bg-indigo-50/80 px-2 py-1 text-[11px] font-semibold text-indigo-800 transition hover:bg-indigo-100 disabled:opacity-50"
                            title={
                              learningDbResolved === true
                                ? "Store this thread as a labeled example (Postgres + OpenAI embeddings). Re-run classification to use kNN overrides."
                                : learningDbResolved === false
                                  ? LEARNING_OPTIONAL_SETUP_MESSAGE
                                  : "Checking learning storage…"
                            }
                          >
                            {savingExampleId === thread.id ? "Saving…" : "Remember for learning"}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })
          )}
        </section>
      </div>

      {settingsOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
          <button
            type="button"
            className="absolute inset-0 z-0 cursor-default border-0 bg-zinc-950/45 p-0 backdrop-blur-[2px]"
            aria-label="Close settings"
            onClick={closeLlmSettings}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
            className="relative z-10 w-full max-w-md rounded-2xl border border-zinc-200/80 bg-white p-6 shadow-2xl shadow-zinc-900/25 ring-1 ring-white/80 sm:p-8"
          >
            <div className="flex items-start justify-between gap-4">
              <h2 id="settings-dialog-title" className="text-lg font-semibold text-zinc-900">
                OpenAI settings
              </h2>
              <button
                type="button"
                onClick={closeLlmSettings}
                className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
                aria-label="Close settings"
              >
                <span className="text-2xl leading-none" aria-hidden>
                  ×
                </span>
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <div className="space-y-1">
                <label htmlFor="settings-api-key" className="text-xs font-medium text-zinc-700">
                  OpenAI API key
                </label>
                <input
                  ref={settingsApiKeyInputRef}
                  id="settings-api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={llmSettingsKeyDraft}
                  onChange={(event) => setLlmSettingsKeyDraft(event.target.value)}
                  placeholder={
                    clientLlmSavedKey?.trim()
                      ? "Enter a new key to replace, or leave blank"
                      : "sk-…"
                  }
                  className="w-full rounded-xl border border-zinc-200/90 bg-white px-3 py-2.5 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/20"
                />
                {formatKeyInUse(clientLlmSavedKey) ? (
                  <p
                    role="status"
                    className="mt-2 rounded-lg border border-emerald-200/90 bg-emerald-50/95 px-3 py-2 text-sm text-emerald-950"
                  >
                    <span className="font-semibold">Saved Key</span>:{" "}
                    <code className="rounded bg-white/90 px-1.5 py-0.5 font-mono text-xs font-semibold tracking-tight text-emerald-950 ring-1 ring-emerald-200/70">
                      {formatKeyInUse(clientLlmSavedKey)}
                    </code>
                  </p>
                ) : null}
              </div>
              <div className="space-y-1">
                <label htmlFor="settings-chat-model" className="text-xs font-medium text-zinc-700">
                  Chat model
                </label>
                <select
                  id="settings-chat-model"
                  value={settingsModelSelectValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === "__custom__") {
                      setLlmSettingsModelDraft((previous) =>
                        previous === "" || chatModelPresetIds.has(previous) ? "" : previous,
                      );
                    } else {
                      setLlmSettingsModelDraft(value);
                    }
                  }}
                  className="w-full rounded-xl border border-zinc-200/90 bg-white px-3 py-2.5 text-sm text-zinc-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/20"
                >
                  {CHAT_MODEL_PRESETS.map((row) => (
                    <option key={row.id || "app-default"} value={row.id}>
                      {row.label}
                    </option>
                  ))}
                  <option value="__custom__">Custom model ID…</option>
                </select>
                {settingsModelSelectValue === "__custom__" ? (
                  <input
                    id="settings-chat-model-custom"
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={LLM_MODEL_ID_MAX_LEN}
                    value={llmSettingsModelDraft}
                    onChange={(event) => setLlmSettingsModelDraft(event.target.value)}
                    placeholder="e.g. o4-mini or your provider's model id"
                    className="mt-2 w-full rounded-xl border border-zinc-200/90 bg-white px-3 py-2.5 font-mono text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-400/20"
                  />
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setClientLlmSavedKey(undefined);
                    setLlmSettingsKeyDraft("");
                    persistClientLlmPrefs({
                      model: clientLlmSavedModel,
                    });
                  }}
                  className="text-sm font-medium text-zinc-600 underline-offset-2 hover:text-zinc-900 hover:underline"
                >
                  Remove key
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const nextKey = llmSettingsKeyDraft.trim();
                    const modelTrim = normalizeStoredModel(llmSettingsModelDraft);
                    const mergedKey = nextKey || clientLlmSavedKey?.trim() || undefined;
                    if (nextKey) {
                      setClientLlmSavedKey(nextKey);
                      setLlmSettingsKeyDraft("");
                    } else if (!mergedKey) {
                      setClientLlmSavedKey(undefined);
                    }
                    setClientLlmSavedModel(modelTrim);
                    persistClientLlmPrefs({
                      apiKey: mergedKey,
                      model: modelTrim,
                    });
                    setLlmSettingsKeyDraft("");
                    setLlmSettingsModelDraft(modelTrim ?? "");
                    setSettingsOpen(false);
                  }}
                  className="rounded-xl border border-indigo-200/90 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-950 transition hover:bg-indigo-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
