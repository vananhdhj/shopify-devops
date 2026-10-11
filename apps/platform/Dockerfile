# syntax=docker/dockerfile:1
# Build context: repository root.
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/service-kit/package.json packages/service-kit/
COPY packages/tenancy/package.json packages/tenancy/
COPY apps/platform/package.json apps/platform/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @shop/platform...
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/service-kit packages/service-kit
COPY packages/tenancy packages/tenancy
COPY apps/platform apps/platform
RUN pnpm --filter "@shop/platform..." build \
 && pnpm --filter @shop/platform deploy --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/platform/dist ./dist
USER node
EXPOSE 8100 8101 8102
CMD ["node", "dist/api-server.js"]
