# python:3.12-slim-bookworm IS Debian 12 ("bookworm") with Python 3.12 installed,
# so this satisfies both "Debian 12" and "Python 3.12" requirements at once.
FROM python:3.12-slim-bookworm

# Build tools so managed projects can compile C-extension deps in their own venvs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY static ./static

# Persistent data: workspace files, per-project venvs (inside workspace), logs, project registry
VOLUME ["/app/data"]
ENV PSM_DATA_DIR=/app/data

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
