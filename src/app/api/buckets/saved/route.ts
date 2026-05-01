import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { accountKeyFromRefreshToken } from "@/lib/accountKey";
import { readGoogleTokensCookie } from "@/lib/authCookies";
import { prisma } from "@/lib/prisma";
import {
  SAVED_BUCKETS_COOKIE,
  parseSavedBucketsCookie,
  serializeSavedBucketsCookie,
  validateBucketList,
} from "@/lib/savedCustomBuckets";

const COOKIE_MAX = 3800;

async function readBucketsFromStore(accountKey: string): Promise<string[]> {
  if (process.env.DATABASE_URL?.trim()) {
    try {
      const row = await prisma.savedCustomBuckets.findUnique({
        where: { accountKey },
      });
      if (row?.buckets != null) {
        const parsed = validateBucketList(row.buckets);
        if (parsed) {
          return parsed;
        }
      }
    } catch {
      // fall through to cookie
    }
  }

  const store = await cookies();
  const raw = store.get(SAVED_BUCKETS_COOKIE)?.value;
  return parseSavedBucketsCookie(raw, accountKey) ?? [];
}

export async function GET() {
  const tokens = await readGoogleTokensCookie();
  if (!tokens?.refresh_token) {
    return NextResponse.json({ message: "Not signed in to Google." }, { status: 401 });
  }

  const accountKey = accountKeyFromRefreshToken(tokens.refresh_token);
  const buckets = await readBucketsFromStore(accountKey);
  return NextResponse.json({
    buckets,
    hasDatabaseUrl: Boolean(process.env.DATABASE_URL?.trim()),
  });
}

export async function POST(request: Request) {
  const tokens = await readGoogleTokensCookie();
  if (!tokens?.refresh_token) {
    return NextResponse.json({ message: "Not signed in to Google." }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { buckets?: unknown };
  if (body.buckets !== undefined && !Array.isArray(body.buckets)) {
    return NextResponse.json(
      { message: "Field buckets must be an array of strings when provided." },
      { status: 400 }
    );
  }
  const list = Array.isArray(body.buckets) ? body.buckets : [];
  const normalized = validateBucketList(list);
  if (normalized === null) {
    return NextResponse.json({ message: "Invalid buckets array." }, { status: 400 });
  }

  const accountKey = accountKeyFromRefreshToken(tokens.refresh_token);

  if (process.env.DATABASE_URL?.trim()) {
    try {
      await prisma.savedCustomBuckets.upsert({
        where: { accountKey },
        create: { accountKey, buckets: normalized },
        update: { buckets: normalized },
      });
      return NextResponse.json({ ok: true, buckets: normalized, storage: "database" });
    } catch {
      // cookie fallback below
    }
  }

  const payload = serializeSavedBucketsCookie(accountKey, normalized);
  if (payload.length > COOKIE_MAX) {
    return NextResponse.json(
      {
        message:
          "Bucket list is too large for cookie storage. Set DATABASE_URL and run prisma migrate deploy.",
      },
      { status: 413 }
    );
  }

  const store = await cookies();
  store.set(SAVED_BUCKETS_COOKIE, payload, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  return NextResponse.json({ ok: true, buckets: normalized, storage: "cookie" });
}
