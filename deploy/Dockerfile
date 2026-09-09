# Multi-stage production build for biomcp Streamable HTTP server
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json tsconfig*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Production runtime stage
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV BIOMCP_HOST=0.0.0.0
ENV BIOMCP_PORT=3000

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/LICENSE /app/NOTICE ./

EXPOSE 3000

# Healthcheck probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.BIOMCP_PORT || 3000) + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

CMD ["node", "dist/cli.js", "serve"]
