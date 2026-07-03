# syntax=docker/dockerfile:1
FROM node:20-alpine AS build

WORKDIR /app
COPY frontend/package.json frontend/yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 300000

COPY frontend/ ./
# At build time the frontend is pointed at "/" — nginx will proxy /api to backend
ENV REACT_APP_BACKEND_URL=""
RUN yarn build

FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
