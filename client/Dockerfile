# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app

# package-lock.json installs @tetrabit/scryfall-cache-client from a local workspace path:
# file:../shared/scryfall-client (relative to /app/client).
# Make that path exist before running `npm ci`.
COPY shared/scryfall-client/package.json shared/scryfall-client/package-lock.json shared/scryfall-client/tsconfig.build.json shared/scryfall-client/index.ts shared/scryfall-client/schema.d.ts /app/shared/scryfall-client/
COPY shared/scryfall-client/README.md /app/shared/scryfall-client/README.md
RUN npm ci --prefix /app/shared/scryfall-client && npm run build --prefix /app/shared/scryfall-client

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
