# One image that serves both the API and the staff web app.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# The staff app's web build; the API serves it from STAFF_WEB_DIR.
RUN cd apps/staff && pnpm exec expo export --platform web --output-dir /app/staff-web

FROM node:22-slim
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends postgresql-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production STAFF_WEB_DIR=/app/staff-web PORT=3000
EXPOSE 3000
# Brings the database schema up to date, then starts the server.
CMD ["sh", "-c", "pnpm --filter @golf/api db:migrate && pnpm --filter @golf/api start"]
