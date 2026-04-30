import { NextResponse } from "next/server";

export async function GET() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return NextResponse.json(
      {
        configured: false,
        message:
          "Google OAuth is not configured yet. Add GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI.",
      },
      { status: 400 }
    );
  }

  const scope = encodeURIComponent(
    [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/gmail.readonly",
    ].join(" ")
  );

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    "&response_type=code" +
    "&access_type=offline" +
    `&scope=${scope}` +
    "&prompt=consent";

  return NextResponse.json({ configured: true, authUrl });
}
