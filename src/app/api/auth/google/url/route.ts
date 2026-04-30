import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getGoogleOAuthClient, GOOGLE_OAUTH_SCOPES } from "@/lib/google";
import { setGoogleStateCookie } from "@/lib/authCookies";

export async function GET() {
  try {
    const oauthClient = getGoogleOAuthClient();
    const state = randomUUID();
    await setGoogleStateCookie(state);

    const authUrl = oauthClient.generateAuthUrl({
      access_type: "offline",
      scope: GOOGLE_OAUTH_SCOPES,
      prompt: "consent",
      state,
    });

    return NextResponse.json({ configured: true, authUrl });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Google OAuth is not configured yet.";
    return NextResponse.json(
      {
        configured: false,
        message,
      },
      { status: 400 }
    );
  }
}
