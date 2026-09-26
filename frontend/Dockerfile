FROM node:24-alpine AS build

WORKDIR /app

COPY frontend/package.json /app/package.json
COPY frontend/package-lock.json* /app/

RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY frontend /app

RUN npm run build


FROM nginx:1.29-alpine

COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
