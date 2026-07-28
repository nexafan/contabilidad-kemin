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

B2_ENABLED="${B2_ENABLED:-false}"
B2_BUCKET="${B2_BUCKET:-}"

# OJO — el destino DEBE ser una subcarpeta propia, nunca la raíz del bucket. `rclone sync`
# es un ESPEJO: apuntando a la raíz borra todo lo que no esté en $BACKUP_DIR, y el bucket
# lo comparte el backup de NexaFans (subcarpeta nexafans/). Apuntar aquí a la raíz dejó a
# NexaFans 6 días sin copia offsite (28-jul-2026): sus 77 ficheros se subían a las 04:00 y
# este sync los borraba a las 04:30, mientras su log seguía diciendo "offsite OK".
# CANDADO: sin subcarpeta no se sincroniza. Los comentarios y el README se ignoran; esto
# no. Si $B2_BUCKET no lleva una '/' con algo detrás, el destino sería la raíz del bucket
# y este sync se llevaría por delante la copia de NexaFans. Antes de fallar en silencio,
# mejor no subir nada y dejarlo dicho: el backup LOCAL sigue estando.
case "$B2_BUCKET" in
  */?*) : ;;   # bucket/subcarpeta → correcto
  *)
    if [ "$B2_ENABLED" = "true" ] && [ -n "$B2_BUCKET" ]; then
      echo "[$(date)] ERROR: B2_BUCKET='$B2_BUCKET' apunta a la RAIZ del bucket."
      echo "[$(date)]        Ese bucket lo comparte el backup de NexaFans y un sync a la raiz"
      echo "[$(date)]        BORRARIA sus copias. Pon B2_BUCKET=$B2_BUCKET/kemin en el .env."
      echo "[$(date)]        No se sube nada offsite; el backup LOCAL si se ha hecho."
      B2_ENABLED=false
    fi
    ;;
esac

if [ "$B2_ENABLED" = "true" ] && [ -n "$B2_BUCKET" ] && command -v rclone >/dev/null 2>&1; then
  echo "[$(date)] Sync to B2 bucket $B2_BUCKET …"
  # rclone debe estar configurado previamente con un remote llamado "b2-kemin"
  # (ver README sección "Backblaze B2")
  # --max-delete: segundo cinturón. Si un día $BACKUP_DIR aparece vacío o medio vacío,
  # el sync aborta en vez de replicar el vacío contra la copia offsite.
  rclone sync "$BACKUP_DIR" "b2-kemin:$B2_BUCKET/" --transfers 4 --max-delete 10 --quiet || \
    echo "[$(date)] ERROR sync to B2"
else
  echo "[$(date)] B2 disabled, bucket vacío o rclone missing → solo backup local"
fi

echo "[$(date)] backup done"
