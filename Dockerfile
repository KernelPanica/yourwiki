FROM rclone/rclone:1.76.0 AS rclone-binary

FROM node:24-bookworm-slim AS web-build
WORKDIR /app/apps/web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts
COPY apps/web ./
COPY wiki/static/wiki/fonts /app/wiki/static/wiki/fonts
RUN npm run build

# Native SQLite builds must work even when a prebuilt addon is unavailable.
FROM node:24-bookworm-slim AS server-build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY apps/server/package.json apps/server/package-lock.json ./apps/server/
RUN npm_config_nodedir=/usr/local npm ci --prefix apps/server --omit=dev

FROM python:3.13-slim AS diagrams
WORKDIR /build
COPY docker/fetch_drawio.py docker/fetch_drawio.py
RUN python docker/fetch_drawio.py

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOME=/tmp YOURWIKI_DATA=/data YOURWIKI_DRAWIO_ROOT=/app/drawio YOURWIKI_OFFICE_FONTS_ROOT=/app/office-fonts
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux fuse3 bubblewrap libreoffice-writer libreoffice-calc libreoffice-impress poppler-utils fonts-dejavu-core python3 python3-venv && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 wiki && useradd --uid 10001 --gid wiki --no-create-home wiki \
    && mkdir -p /data /backups && chown wiki:wiki /data /backups
COPY --from=rclone-binary /usr/local/bin/rclone /usr/bin/rclone
RUN mkdir -p /opt/yourwiki-rclone-tools/fuse/usr/bin \
    && ln -s /usr/bin/rclone /opt/yourwiki-rclone-tools/rclone \
    && ln -s /usr/bin/fusermount3 /opt/yourwiki-rclone-tools/fuse/usr/bin/fusermount3 \
    && chmod u+s /usr/bin/fusermount3
COPY docker/v2/rclone-settings.json /opt/yourwiki-rclone-settings.json
COPY docker/v2/network-requirements.txt /tmp/network-requirements.txt
RUN python3 -m venv /opt/yourwiki-network \
    && /opt/yourwiki-network/bin/pip install --no-cache-dir -r /tmp/network-requirements.txt \
    && rm /tmp/network-requirements.txt
COPY apps/server/package.json apps/server/package-lock.json ./apps/server/
COPY --from=server-build /app/apps/server/node_modules ./apps/server/node_modules
COPY apps/server/src ./apps/server/src
COPY package.json ./
COPY --from=web-build /app/apps/web/dist ./apps/web/dist
COPY --from=diagrams /build/wiki/static/drawio ./drawio
COPY wiki/static/wiki/fonts/office ./office-fonts
COPY docker/v2/entrypoint.sh /usr/local/bin/yourwiki-entrypoint
USER wiki
EXPOSE 3100
ENTRYPOINT ["/usr/local/bin/yourwiki-entrypoint"]
CMD ["web"]
