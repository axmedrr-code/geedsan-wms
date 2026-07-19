FROM node:20-alpine

WORKDIR /app

# postgresql-client provides pg_dump used by backup scripts at runtime.
# Create the non-root user in the same layer to keep the image lean.
RUN apk add --no-cache postgresql-client \
    && addgroup -S appgroup \
    && adduser -S appuser -G appgroup

# Install production dependencies only.
# --omit=dev is the current equivalent of the deprecated --only=production.
# Copying package files before source ensures this layer is cached unless
# dependencies actually change — no CACHEBUST workaround needed on Linux.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations

# Create runtime directories while still root, then transfer full ownership
# before switching user. Docker-named volumes mounted over these paths inherit
# the directory ownership set here when first created.
RUN mkdir -p /app/uploads /app/reports /app/logs /app/backups \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)}).on('error', (e) => {throw e})" || exit 1

CMD ["node", "src/index.js"]
