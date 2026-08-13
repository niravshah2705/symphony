FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Build from the monorepo root. The settings service consumes the canonical,
# versioned harness catalog owned by shared-core without copying a second source
# file into the Python package.
COPY services/settings/ .
COPY packages/shared-core/src/agent/harness-catalog.json ./app/domain/harness-catalog.json
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir .

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
