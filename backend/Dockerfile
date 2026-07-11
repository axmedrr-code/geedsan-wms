FROM node:20-alpine

WORKDIR /app

# Install dependencies (cached unless package.json changes)
COPY package*.json ./
RUN npm ci --only=production

# CACHEBUST: changing this ARG in docker-compose.yml build.args forces Docker
# to invalidate every layer below this point and re-copy all source files.
# This is the fix for Docker Desktop / Windows where COPY src layer cache is
# not always invalidated when source files change on the host filesystem.
# To force a rebuild: update the CACHEBUST value in docker-compose.yml.
ARG CACHEBUST=1
RUN echo "Build ID: $CACHEBUST"

# Copy source (cache-busted by ARG above when CACHEBUST changes)
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations

# Create required directories
RUN mkdir -p /app/uploads /app/reports /app/logs

EXPOSE 5000

# Healthcheck using Node.js (no external dependencies)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)}).on('error', (e) => {throw e})" || exit 1

CMD ["node", "src/index.js"]
