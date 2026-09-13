FROM node:22.22.2-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/bridge/package.json ./apps/bridge/package.json
RUN pnpm install --frozen-lockfile --filter @esign/bridge...
COPY apps/bridge ./apps/bridge
RUN pnpm --filter @esign/bridge build
RUN pnpm --filter @esign/bridge deploy --legacy --prod /release

FROM node:22.22.2-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4100
COPY --from=build --chown=node:node /release/package.json ./package.json
COPY --from=build --chown=node:node /release/node_modules ./node_modules
COPY --from=build --chown=node:node /release/dist ./dist
USER node
EXPOSE 4100
CMD ["node", "dist/main.js"]
