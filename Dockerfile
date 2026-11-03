FROM node:24-bookworm-slim AS web-build
WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY apps/web ./
COPY wiki/static/wiki/fonts /app/wiki/static/wiki/fonts
RUN npm run build

FROM python:3.13-slim AS diagrams
WORKDIR /build
COPY docker/fetch_drawio.py docker/fetch_drawio.py
RUN python docker/fetch_drawio.py

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOME=/tmp YOURWIKI_DATA=/data YOURWIKI_DRAWIO_ROOT=/app/drawio
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux bubblewrap libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils fonts-dejavu-core && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 wiki && useradd --uid 10001 --gid wiki --no-create-home wiki \
    && mkdir -p /data /backups && chown wiki:wiki /data /backups
COPY apps/server/package.json apps/server/package-lock.json ./apps/server/
RUN npm ci --prefix apps/server --omit=dev
COPY apps/server/src ./apps/server/src
COPY package.json ./
COPY --from=web-build /app/apps/web/dist ./apps/web/dist
COPY --from=diagrams /build/wiki/static/drawio ./drawio
COPY docker/v2/entrypoint.sh /usr/local/bin/yourwiki-entrypoint
USER wiki
EXPOSE 3100
ENTRYPOINT ["/usr/local/bin/yourwiki-entrypoint"]
CMD ["web"]
