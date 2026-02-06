# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
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
