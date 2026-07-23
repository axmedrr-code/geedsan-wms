FROM node:20-alpine AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

ARG NEXT_PUBLIC_API_URL=http://localhost:5000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

COPY package*.json ./
RUN npm ci

COPY . .

# Docker build contexts omit empty directories; mkdir -p ensures /app/public
# exists in the image layer so the runner-stage COPY never fails with "not found".
RUN mkdir -p /app/public

RUN npm run build

# ── Production image ──────────────────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Bind to all interfaces so nginx can reach this container via Docker DNS.
# Without this, Next.js 14 standalone defaults to localhost (127.0.0.1),
# which is unreachable from other containers.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# public/ is served as-is by the standalone server; must live at /app/public
COPY --from=builder --chown=nextjs:nodejs /app/public          ./public

# standalone/ contains server.js + a minimal node_modules tree
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./

# static assets must be at .next/static relative to the standalone server root
COPY --from=builder --chown=nextjs:nodejs /app/.next/static    ./.next/static

# Ensure .next is writable by the runtime user for any Next.js cache writes
RUN mkdir -p .next && chown nextjs:nodejs .next

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://localhost:3000/login',r=>{process.exit(r.statusCode<400?0:1)}).on('error',()=>process.exit(1))"]

USER nextjs

CMD ["node", "server.js"]
