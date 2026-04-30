import { NextResponse } from "next/server";
import { readGoogleTokensCookie } from "@/lib/authCookies";

export async function GET() {
  const tokens = await readGoogleTokensCookie();

  if (!tokens || (!tokens.access_token && !tokens.refresh_token)) {
    return NextResponse.json({ connected: false });
  }

  return NextResponse.json({
    connected: true,
    hasRefreshToken: Boolean(tokens.refresh_token),
    hasAccessToken: Boolean(tokens.access_token),
  });
}
