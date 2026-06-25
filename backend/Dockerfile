FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy source
COPY src ./src
COPY scripts ./scripts

# Create required directories
RUN mkdir -p /app/uploads /app/reports /app/logs

EXPOSE 5000

# Healthcheck using Node.js (no external dependencies)
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)}).on('error', (e) => {throw e})" || exit 1

CMD ["node", "src/index.js"]
