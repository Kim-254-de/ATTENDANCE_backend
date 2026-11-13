# Attendance Node API, as deployed on KENET (CI builds it: .github/workflows/deploy.yml).
# Migrations run before the server starts.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY db ./db
USER node
EXPOSE 4000
CMD ["sh", "-c", "npm run db:migrate && exec node dist/server.js"]
