# syntax=docker/dockerfile:1
# Build context: repository root.
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/service-kit/package.json packages/service-kit/
COPY packages/tenancy/package.json packages/tenancy/
COPY apps/router/package.json apps/router/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @shop/router...
COPY tsconfig.base.json ./
COPY packages/service-kit packages/service-kit
COPY packages/tenancy packages/tenancy
COPY apps/router apps/router
RUN pnpm --filter "@shop/router..." build \
 && pnpm --filter @shop/router deploy --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/router/dist ./dist
USER node
EXPOSE 8000 8001
CMD ["node", "dist/server.js"]
