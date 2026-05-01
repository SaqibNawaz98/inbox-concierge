import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { google } from "googleapis";
import {
  persistMinimalGoogleOAuthCookie,
  readGoogleTokensCookie,
} from "@/lib/authCookies";
import {
  GMAIL_THREADS_LIST_PAGE_CAP,
  maxInboxThreadsFromEnv,
  parseInboxThreadLimit,
} from "@/lib/gmailInboxLimits";
import { getGoogleOAuthClient } from "@/lib/google";
import type { EmailThread } from "@/lib/types";

/** Large inbox pulls can take several minutes (many Gmail thread.get calls). */
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const storedTokens = await readGoogleTokensCookie();
  if (!storedTokens || (!storedTokens.access_token && !storedTokens.refresh_token)) {
    return NextResponse.json(
      { message: "Not connected to Google. Authenticate first." },
      { status: 401 }
    );
  }

  const limit = parseInboxThreadLimit(request.nextUrl.searchParams.get("limit"));
  const maxAllowed = maxInboxThreadsFromEnv();
  const rawListPage = Number(process.env.GMAIL_THREADS_LIST_PAGE_SIZE);
  const listPageSize = Math.min(
    GMAIL_THREADS_LIST_PAGE_CAP,
    Number.isFinite(rawListPage) && rawListPage >= 1
      ? Math.floor(rawListPage)
      : GMAIL_THREADS_LIST_PAGE_CAP,
  );
  const rawConcurrency = Number(process.env.GMAIL_THREAD_FETCH_CONCURRENCY);
  const fetchConcurrency = Math.min(
    40,
    Math.max(
      4,
      Number.isFinite(rawConcurrency) && rawConcurrency >= 1
        ? Math.floor(rawConcurrency)
        : 20,
    ),
  );

  if (storedTokens.refresh_token) {
    await persistMinimalGoogleOAuthCookie(storedTokens.refresh_token);
  }

  try {
    const oauthClient = getGoogleOAuthClient();
    if (storedTokens.refresh_token) {
      oauthClient.setCredentials({
        refresh_token: storedTokens.refresh_token,
      });
    } else {
      oauthClient.setCredentials({
        access_token: storedTokens.access_token ?? undefined,
      });
    }

    await oauthClient.getAccessToken();

    const gmail = google.gmail({ version: "v1", auth: oauthClient });

    const threadRefs: { id?: string | null }[] = [];
    let pageToken: string | undefined;

    while (threadRefs.length < limit) {
      const remaining = limit - threadRefs.length;
      const maxResults = Math.min(listPageSize, remaining);
      const listResponse = await gmail.users.threads.list({
        userId: "me",
        labelIds: ["INBOX"],
        maxResults,
        pageToken,
      });
      const page = listResponse.data.threads ?? [];
      threadRefs.push(...page);
      pageToken = listResponse.data.nextPageToken ?? undefined;
      if (!pageToken || page.length === 0) {
        break;
      }
    }

    const trimmed = threadRefs.slice(0, limit);
    const threads: EmailThread[] = [];

    for (let index = 0; index < trimmed.length; index += fetchConcurrency) {
      const chunk = trimmed.slice(index, index + fetchConcurrency);
      const fetched = await Promise.all(
        chunk.map(async (threadRef) => {
          if (!threadRef.id) {
            return null;
          }
          const detail = await gmail.users.threads.get({
            userId: "me",
            id: threadRef.id,
            format: "metadata",
            metadataHeaders: ["Subject", "From", "Date"],
          });

          const messages = detail.data.messages ?? [];
          const latestMessage = messages.reduce<(typeof messages)[number] | undefined>(
            (best, msg) => {
              const t = Number(msg.internalDate ?? 0);
              const bt = Number(best?.internalDate ?? 0);
              return t >= bt ? msg : best;
            },
            undefined,
          );
          const headers = latestMessage?.payload?.headers ?? [];
          const subject = headers.find((h) => h.name === "Subject")?.value ?? "(No subject)";
          const sender = headers.find((h) => h.name === "From")?.value ?? "Unknown sender";
          const receivedAt = headers.find((h) => h.name === "Date")?.value ?? "";
          const preview = detail.data.snippet ?? "";

          return {
            id: threadRef.id,
            subject,
            preview,
            sender,
            receivedAt,
          } satisfies EmailThread;
        })
      );
      threads.push(...fetched.filter((item): item is EmailThread => item !== null));
    }

    return NextResponse.json({
      source: "gmail",
      count: threads.length,
      requestedLimit: limit,
      maxAllowed,
      threads,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch Gmail threads.";
    return NextResponse.json({ message }, { status: 500 });
  }
}
