# Production Dockerfile for AI Virtual Software House Platform
FROM node:22-alpine AS runtime

LABEL maintainer="AI Virtual Software House Team"
LABEL description="Autonomous multi-agent software engineering organization platform"

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install build/git dependencies if needed
RUN apk add --no-cache bash git

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm install --production --ignore-scripts || true

# Copy application source code
COPY src ./src
COPY public ./public
COPY apps ./apps

# Create persistent storage directories with appropriate permissions
RUN mkdir -p /app/data/workspaces /app/data/db && chown -R node:node /app

# Run as unprivileged node user
USER node

EXPOSE 3000

# Health check verifies the REST API telemetry endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:3000/api/status").then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))'

CMD ["node", "src/server/server.js"]
