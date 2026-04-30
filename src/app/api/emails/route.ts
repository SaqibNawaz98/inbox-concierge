import { NextResponse } from "next/server";
import { google } from "googleapis";
import { readGoogleTokensCookie, setGoogleTokensCookie } from "@/lib/authCookies";
import { getGoogleOAuthClient } from "@/lib/google";
import type { EmailThread } from "@/lib/types";

export async function GET() {
  const storedTokens = await readGoogleTokensCookie();
  if (!storedTokens || (!storedTokens.access_token && !storedTokens.refresh_token)) {
    return NextResponse.json(
      { message: "Not connected to Google. Authenticate first." },
      { status: 401 }
    );
  }

  try {
    const oauthClient = getGoogleOAuthClient();
    oauthClient.setCredentials({
      access_token: storedTokens.access_token ?? undefined,
      refresh_token: storedTokens.refresh_token ?? undefined,
      expiry_date: storedTokens.expiry_date ?? undefined,
    });

    // This refreshes access token when needed and updates oauth credentials.
    await oauthClient.getAccessToken();
    const refreshed = oauthClient.credentials;
    await setGoogleTokensCookie({
      access_token: refreshed.access_token ?? storedTokens.access_token ?? null,
      refresh_token: refreshed.refresh_token ?? storedTokens.refresh_token ?? null,
      expiry_date: refreshed.expiry_date ?? storedTokens.expiry_date ?? null,
    });

    const gmail = google.gmail({ version: "v1", auth: oauthClient });
    const listResponse = await gmail.users.threads.list({
      userId: "me",
      maxResults: 200,
    });
    const threadRefs = listResponse.data.threads ?? [];

    const threads: EmailThread[] = [];
    for (let index = 0; index < threadRefs.length; index += 20) {
      const chunk = threadRefs.slice(index, index + 20);
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

          const firstMessage = detail.data.messages?.[0];
          const headers = firstMessage?.payload?.headers ?? [];
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
      threads,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to fetch Gmail threads.";
    return NextResponse.json({ message }, { status: 500 });
  }
}
