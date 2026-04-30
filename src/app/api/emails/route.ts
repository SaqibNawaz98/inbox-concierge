import { NextResponse } from "next/server";
import { MOCK_THREADS } from "@/lib/mockEmails";

export async function GET() {
  // Minimal skeleton response. Replace with Gmail API fetch for last 200 threads.
  return NextResponse.json({
    source: "mock",
    threads: MOCK_THREADS,
  });
}
