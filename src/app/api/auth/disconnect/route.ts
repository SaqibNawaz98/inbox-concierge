import { NextResponse } from "next/server";
import { clearGoogleTokensCookie } from "@/lib/authCookies";

export async function POST() {
  await clearGoogleTokensCookie();
  return NextResponse.json({ ok: true });
}
