# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app

# package-lock.json installs @kclipsto/scryfall-cache-client from a local workspace path:
# file:../shared/scryfall-client (relative to /app/client).
# Make that path exist before running `npm ci`.
COPY shared/scryfall-client/package.json /app/shared/scryfall-client/package.json
COPY shared/scryfall-client/dist /app/shared/scryfall-client/dist
COPY shared/scryfall-client/README.md /app/shared/scryfall-client/README.md
COPY shared/scryfall-client/schema.d.ts /app/shared/scryfall-client/schema.d.ts

WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client/ ./
COPY shared/ /app/shared/
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
