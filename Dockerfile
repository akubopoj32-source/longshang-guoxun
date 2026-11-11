ARG ORCHARD_PYTHON_IMAGE=python:3.12-slim
FROM ${ORCHARD_PYTHON_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN groupadd --system orchard && useradd --system --gid orchard orchard \
    && install -d -o orchard -g orchard /data
COPY app.py .
COPY orchard_workbench orchard_workbench
USER orchard
EXPOSE 8765
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s \
    CMD ["python", "-c", "from urllib.request import urlopen; urlopen('http://127.0.0.1:8765/api/health', timeout=2).close()"]
CMD ["python", "app.py", "--host", "0.0.0.0", "--port", "8765", "--db", "/data/records.sqlite3"]
