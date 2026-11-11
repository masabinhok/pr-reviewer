# The API and its worker, one process. Build from the repository root:
#   docker build -f apps/api/Dockerfile -t pr-reviewer-api .
FROM node:22-slim AS build
WORKDIR /repo
# Prisma's schema engine links against OpenSSL, which the slim image leaves out.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w api --include-workspace-root
COPY apps/api apps/api
WORKDIR /repo/apps/api
RUN npx prisma generate && npx nest build

FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w api --include-workspace-root --omit=dev && npm cache clean --force
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma7.config.ts apps/api/
WORKDIR /repo/apps/api
USER node
EXPOSE 3333
# Render's free plan has no pre-deploy step, so pending migrations apply at start. One
# instance, so nothing races; with none pending it takes a second or two.
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main"]
