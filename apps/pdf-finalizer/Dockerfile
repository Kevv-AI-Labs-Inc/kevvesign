FROM node:22.22.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/pdf-finalizer ./apps/pdf-finalizer
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @esign/pdf-finalizer... build

FROM node:22.22.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
USER node
COPY --from=build --chown=node:node /app/apps/pdf-finalizer/dist ./apps/pdf-finalizer/dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/pdf-finalizer/node_modules ./apps/pdf-finalizer/node_modules
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build --chown=node:node /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build --chown=node:node /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /app/packages/domain/node_modules ./packages/domain/node_modules
COPY --from=build --chown=node:node /app/packages/infrastructure/package.json ./packages/infrastructure/package.json
COPY --from=build --chown=node:node /app/packages/infrastructure/dist ./packages/infrastructure/dist
COPY --from=build --chown=node:node /app/packages/infrastructure/node_modules ./packages/infrastructure/node_modules
CMD ["node", "apps/pdf-finalizer/dist/main.js"]
