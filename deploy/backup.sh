#!/bin/bash
# =============================================================================
# Backup diario de contabilidad-kemin.
#   - Copia kemin.db a /opt/backups/kemin/ con timestamp.
#   - Rota: mantiene los últimos 30 días en local.
#   - Si B2_ENABLED=true en /opt/contabilidad-kemin/.env, sincroniza con Backblaze.
#
# Instalar:
#   chmod +x /opt/contabilidad-kemin/deploy/backup.sh
#   crontab -e   # añadir:
#   30 4 * * * /opt/contabilidad-kemin/deploy/backup.sh >> /var/log/kemin-backup.log 2>&1
# =============================================================================

set -euo pipefail

APP_DIR="/opt/contabilidad-kemin"
DB_FILE="$APP_DIR/data/kemin.db"
BACKUP_DIR="/opt/backups/kemin"
UPLOADS_DIR="$APP_DIR/uploads"
STAMP="$(date +%Y-%m-%d_%H%M)"

mkdir -p "$BACKUP_DIR"

# 1) Snapshot atómico de SQLite (.backup garantiza coherencia bajo WAL)
DB_OUT="$BACKUP_DIR/kemin-$STAMP.db"
if [ -f "$DB_FILE" ]; then
  sqlite3 "$DB_FILE" ".backup '$DB_OUT'"
  gzip -f "$DB_OUT"
  echo "[$(date)] DB snapshot → $DB_OUT.gz"
else
  echo "[$(date)] WARN: $DB_FILE no existe, skipping DB"
fi

# 2) Tarball incremental de uploads
if [ -d "$UPLOADS_DIR" ]; then
  TAR_OUT="$BACKUP_DIR/uploads-$STAMP.tar.gz"
  tar -czf "$TAR_OUT" -C "$APP_DIR" uploads 2>/dev/null || true
  echo "[$(date)] Uploads tarball → $TAR_OUT"
fi

# 3) Rotación local: borrar > 30 días
find "$BACKUP_DIR" -type f -mtime +30 -delete

# 4) Sync a Backblaze B2 si está habilitado
if [ -f "$APP_DIR/.env" ]; then
  set -a; . "$APP_DIR/.env"; set +a
fi

if [ "${B2_ENABLED:-false}" = "true" ] && command -v rclone >/dev/null 2>&1; then
  echo "[$(date)] Sync to B2 bucket $B2_BUCKET …"
  # rclone debe estar configurado previamente con un remote llamado "b2-kemin"
  # (ver README sección "Backblaze B2")
  rclone sync "$BACKUP_DIR" "b2-kemin:$B2_BUCKET/" --transfers 4 --quiet || \
    echo "[$(date)] ERROR sync to B2"
else
  echo "[$(date)] B2 disabled or rclone missing, only local backup"
fi

echo "[$(date)] backup done"
