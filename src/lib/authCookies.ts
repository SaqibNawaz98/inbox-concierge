import { cookies } from "next/headers";

export const GOOGLE_STATE_COOKIE = "google_oauth_state";
export const GOOGLE_TOKENS_COOKIE = "google_oauth_tokens";

export type StoredGoogleTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
};

/**
 * Persist only the OAuth refresh token. Google access tokens are large JWTs and
 * routinely exceed browser cookie limits (~4KB); the gmail route refreshes short-lived access.
 */
export async function persistMinimalGoogleOAuthCookie(refreshToken: string) {
  const cookieStore = await cookies();
  cookieStore.set(GOOGLE_TOKENS_COOKIE, JSON.stringify({ refresh_token: refreshToken }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function setGoogleStateCookie(state: string) {
  const cookieStore = await cookies();
  cookieStore.set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });
}

export async function readGoogleStateCookie() {
  const cookieStore = await cookies();
  return cookieStore.get(GOOGLE_STATE_COOKIE)?.value ?? null;
}

export async function clearGoogleStateCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(GOOGLE_STATE_COOKIE);
}

export async function setGoogleTokensCookie(tokens: StoredGoogleTokens) {
  const refresh = tokens.refresh_token;
  if (!refresh) {
    return;
  }
  await persistMinimalGoogleOAuthCookie(refresh);
}

export async function readGoogleTokensCookie(): Promise<StoredGoogleTokens | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(GOOGLE_TOKENS_COOKIE)?.value;
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as StoredGoogleTokens;
  } catch {
    return null;
  }
}

export async function clearGoogleTokensCookie() {
  const cookieStore = await cookies();
  cookieStore.delete(GOOGLE_TOKENS_COOKIE);
}
