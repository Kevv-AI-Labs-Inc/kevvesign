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
COPY --from=build --chown=node:node /app/apps/pdf-finalizer/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/pdf-finalizer/node_modules ./apps/pdf-finalizer/node_modules
CMD ["node", "dist/main.js"]
