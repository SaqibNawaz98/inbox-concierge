import { NextRequest, NextResponse } from "next/server";
import {
  clearGoogleStateCookie,
  readGoogleStateCookie,
  setGoogleTokensCookie,
} from "@/lib/authCookies";
import { getGoogleOAuthClient } from "@/lib/google";

function buildHomeRedirect(status: "success" | "error", reason?: string) {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const url = new URL("/", appUrl);
  url.searchParams.set("auth", status);
  if (reason) {
    url.searchParams.set("reason", reason);
  }
  return url.toString();
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(buildHomeRedirect("error", error));
  }

  if (!code || !state) {
    return NextResponse.redirect(buildHomeRedirect("error", "missing_code_or_state"));
  }

  const storedState = await readGoogleStateCookie();
  await clearGoogleStateCookie();
  if (!storedState || storedState !== state) {
    return NextResponse.redirect(buildHomeRedirect("error", "invalid_state"));
  }

  try {
    const oauthClient = getGoogleOAuthClient();
    const tokenResponse = await oauthClient.getToken(code);
    const tokens = tokenResponse.tokens;

    await setGoogleTokensCookie({
      access_token: tokens.access_token ?? null,
      refresh_token: tokens.refresh_token ?? null,
      expiry_date: tokens.expiry_date ?? null,
    });

    return NextResponse.redirect(buildHomeRedirect("success"));
  } catch {
    return NextResponse.redirect(buildHomeRedirect("error", "token_exchange_failed"));
  }
}
