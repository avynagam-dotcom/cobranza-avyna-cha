#!/usr/bin/env bash
set -e

echo "▶ Backup script starting"
echo "PWD: $(pwd)"
echo "Listing current dir:"
ls -la

echo "Listing scripts dir:"
ls -la scripts || true

# Validaciones mínimas
: "${R2_ENDPOINT:?missing}"
: "${R2_ACCESS_KEY_ID:?missing}"
: "${R2_SECRET_ACCESS_KEY:?missing}"
: "${R2_BUCKET:?missing}"
: "${DATA_DIR:?missing}"

echo "All required env vars present"
echo "DATA_DIR=$DATA_DIR"

# Aquí todavía NO hacemos el backup real
echo "Script reached end successfully"
