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
COPY apps/catalog-cart-api/package.json apps/catalog-cart-api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @shop/catalog-cart-api...
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/service-kit packages/service-kit
COPY apps/catalog-cart-api apps/catalog-cart-api
RUN pnpm --filter "@shop/catalog-cart-api..." build \
 && pnpm --filter @shop/catalog-cart-api deploy --prod /out

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/catalog-cart-api/dist ./dist
USER node
EXPOSE 4001
CMD ["node", "dist/server.js"]
