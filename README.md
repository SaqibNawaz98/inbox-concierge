## Inbox Concierge (Skeleton)

Minimal starter for the take-home **Inbox Concierge** project:

- React web app with Next.js (App Router)
- Google OAuth URL generation endpoint
- Mock Gmail thread ingestion endpoint
- Bucket classification endpoint + custom bucket recategorization
- Simple UI for "connect, classify, add buckets, reclassify"

## Quick Start

1. Install dependencies:
   - `npm install`
2. Copy environment template:
   - `cp .env.example .env.local`
3. Run dev server:
   - `npm run dev`
4. Open [http://localhost:3000](http://localhost:3000)

## Current API Endpoints

- `GET /api/auth/google/url`
  - Returns Google OAuth URL if env vars are configured.
- `GET /api/emails`
  - Returns mock email threads (replace with Gmail API last-200-thread fetch).
- `POST /api/classify`
  - Accepts optional `customBuckets`, classifies threads into buckets.
- `POST /api/buckets/reclassify`
  - Re-runs classification after custom bucket updates.

## What To Implement Next (Production)

1. OAuth callback route to exchange authorization code and persist refresh token.
2. Gmail fetch pipeline for last 200 threads (`users.threads.list` + `users.threads.get`).
3. LLM classifier replacing rule-based placeholder classifier.
4. Lightweight persistence (Postgres + Prisma) for users, bucket defs, and cached classifications.
5. Background job queue for async recategorization and progress updates.

## Deployment

- Recommended: Vercel for frontend + API routes.
- Configure Google OAuth redirect URI to your deployed domain callback.
- Add env vars in Vercel project settings.

## Notes

- This repository intentionally starts with mock data and deterministic rules to keep scope minimal.
- The skeleton is designed so you can quickly swap each stage with real Gmail + LLM logic.
