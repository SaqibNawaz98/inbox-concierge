import { NextResponse } from "next/server";
import { isLearningDatabaseConfigured } from "@/lib/learningDb";

/** Lets the client disable "Remember" when Postgres is not wired (no DATABASE_URL). */
export async function GET() {
  return NextResponse.json({
    available: isLearningDatabaseConfigured(),
  });
}
