FROM python:3.12-alpine

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app

# UID/GID, unter denen die App läuft. Mit dem benannten Volume aus
# docker-compose.yml passt der Standard. Nur wer /data als Bind-Mount einbindet,
# muss den Ordner auf dem Host dieser UID geben (chown 1000:1000 …).
ARG APP_UID=1000
ARG APP_GID=1000
RUN addgroup -g ${APP_GID} app \
 && adduser -D -u ${APP_UID} -G app app \
 && mkdir -p /data && chown app:app /data

# Nur Standardbibliothek – kein pip install nötig.
COPY server.py ./
COPY app ./app

USER ${APP_UID}:${APP_GID}
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4).status == 200 else 1)"

CMD ["python", "server.py"]
