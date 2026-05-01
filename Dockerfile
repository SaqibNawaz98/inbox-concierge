# syntax=docker/dockerfile:1
# Production image: pinned Node base + deterministic `npm ci` + Next.js standalone bundle.
#
# Build: docker build -t inbox-concierge:latest .
# Run:   docker run --rm -p 3000:3000 \
#           -e DATABASE_URL=postgresql://... \
#           -e GOOGLE_CLIENT_ID=… -e GOOGLE_CLIENT_SECRET=… \
#           -e GOOGLE_REDIRECT_URI=… -e NEXT_PUBLIC_APP_URL=… \
#           inbox-concierge:latest
#
# From compose, sibling services reach Postgres at postgresql://inbox:inbox@postgres:5432/inbox_concierge

ARG NODE_MAJOR_MINOR=20.9

FROM node:${NODE_MAJOR_MINOR}-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma/
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma/
COPY tsconfig.json next.config.ts postcss.config.mjs eslint.config.mjs ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --gid 1001 nodejs \
  && useradd --uid 1001 --gid nodejs --create-home \
    --shell /usr/sbin/nologin nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json

# Engine + generated client are not fully traced into standalone output.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
