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
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @shop/worker...
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/service-kit packages/service-kit
COPY packages/tenancy packages/tenancy
COPY apps/worker apps/worker
RUN pnpm --filter "@shop/worker..." build \
 && pnpm --filter @shop/worker deploy --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
USER node
EXPOSE 4003
CMD ["node", "dist/main.js"]
