"use client";

import { FormEvent, useMemo, useState } from "react";
import type { BucketedThreads } from "@/lib/types";

export default function Home() {
  const [customBucketInput, setCustomBucketInput] = useState("");
  const [customBuckets, setCustomBuckets] = useState<string[]>([]);
  const [bucketedThreads, setBucketedThreads] = useState<BucketedThreads>({});
  const [status, setStatus] = useState("Idle");
  const [oauthMessage, setOauthMessage] = useState("");

  const bucketNames = useMemo(() => Object.keys(bucketedThreads), [bucketedThreads]);

  async function classifyCurrent(custom: string[]) {
    setStatus("Classifying...");
    const response = await fetch("/api/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customBuckets: custom }),
    });
    const data = await response.json();
    setBucketedThreads(data.classification ?? {});
    setStatus("Done");
  }

  async function handleConnectGoogle() {
    setOauthMessage("");
    const response = await fetch("/api/auth/google/url");
    const data = await response.json();

    if (!response.ok) {
      setOauthMessage(data.message ?? "Google OAuth is not configured yet.");
      return;
    }

    window.location.href = data.authUrl;
  }

  function handleAddBucket(event: FormEvent) {
    event.preventDefault();
    const value = customBucketInput.trim();
    if (!value) {
      return;
    }

    if (customBuckets.includes(value)) {
      setCustomBucketInput("");
      return;
    }

    const next = [...customBuckets, value];
    setCustomBuckets(next);
    setCustomBucketInput("");
    void classifyCurrent(next);
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="rounded-xl border border-slate-200 bg-white p-6">
          <h1 className="text-2xl font-bold">Inbox Concierge</h1>
          <p className="mt-2 text-sm text-slate-600">
            Minimal starter for OAuth, Gmail ingestion, and LLM bucket classification.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              onClick={handleConnectGoogle}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Connect Google
            </button>
            <button
              onClick={() => void classifyCurrent(customBuckets)}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium hover:bg-slate-100"
            >
              Load + Classify Threads
            </button>
            <span className="self-center text-xs text-slate-500">Status: {status}</span>
          </div>
          {oauthMessage ? <p className="mt-3 text-sm text-amber-700">{oauthMessage}</p> : null}
        </header>

        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold">Custom Buckets</h2>
          <form onSubmit={handleAddBucket} className="mt-3 flex gap-2">
            <input
              value={customBucketInput}
              onChange={(event) => setCustomBucketInput(event.target.value)}
              placeholder="e.g., Follow up this week"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Add
            </button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {customBuckets.length === 0 ? (
              <span className="text-sm text-slate-500">No custom buckets yet.</span>
            ) : (
              customBuckets.map((bucket) => (
                <span
                  key={bucket}
                  className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-xs"
                >
                  {bucket}
                </span>
              ))
            )}
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-2">
          {bucketNames.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
              Click &quot;Load + Classify Threads&quot; to see bucketed threads.
            </div>
          ) : (
            bucketNames.map((bucketName) => (
              <article key={bucketName} className="rounded-xl border border-slate-200 bg-white p-4">
                <h3 className="text-base font-semibold">
                  {bucketName} ({bucketedThreads[bucketName]?.length ?? 0})
                </h3>
                <ul className="mt-3 space-y-3">
                  {(bucketedThreads[bucketName] ?? []).map((thread) => (
                    <li key={thread.id} className="rounded-lg border border-slate-200 p-3">
                      <p className="text-sm font-medium">{thread.subject}</p>
                      <p className="mt-1 text-xs text-slate-500">{thread.preview}</p>
                      <p className="mt-1 text-xs text-slate-400">{thread.sender}</p>
                    </li>
                  ))}
                </ul>
              </article>
            ))
          )}
        </section>
      </div>
    </main>
  );
}
