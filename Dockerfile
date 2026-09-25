FROM node:24-bookworm-slim AS editors
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend frontend
RUN npm run build

FROM python:3.13-slim AS diagrams
WORKDIR /build
COPY docker/fetch_drawio.py docker/fetch_drawio.py
RUN python docker/fetch_drawio.py

FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    YOURWIKI_DATA=/data YOURWIKI_SECRETS=/secrets YOURWIKI_DOCUMENTS=/documents \
    DJANGO_SETTINGS_MODULE=config.settings
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
RUN groupadd --gid 10001 wiki && useradd --uid 10001 --gid wiki --no-create-home wiki \
    && mkdir -p /data /secrets /documents /app/staticfiles \
    && chown -R wiki:wiki /data /secrets /documents /app
COPY --chown=wiki:wiki config config
COPY --chown=wiki:wiki wiki wiki
COPY --from=editors --chown=wiki:wiki /build/wiki/static/wiki/dist wiki/static/wiki/dist
COPY --from=diagrams --chown=wiki:wiki /build/wiki/static/drawio wiki/static/drawio
COPY --chown=wiki:wiki docker docker
COPY --chown=wiki:wiki manage.py install.py ./
USER wiki
RUN DJANGO_SECRET_KEY=build-only-static-collection python manage.py collectstatic --noinput
EXPOSE 8000
CMD ["python", "-m", "docker.start"]
