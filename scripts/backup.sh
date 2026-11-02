#!/bin/sh
# Saves the whole database to a dated, compressed file and removes copies older than KEEP_DAYS.
# Run it every night (cron) and copy the folder off the machine: a backup on the same disk
# doesn't survive that disk failing.
#   DATABASE_URL=postgres://... scripts/backup.sh [folder]
set -eu
DIR="${1:-backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
: "${DATABASE_URL:?set DATABASE_URL}"
mkdir -p "$DIR"
FILE="$DIR/golf-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump --no-owner --clean --if-exists "$DATABASE_URL" | gzip > "$FILE.partial"
mv "$FILE.partial" "$FILE"
find "$DIR" -name 'golf-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "Saved $FILE ($(du -h "$FILE" | cut -f1))"
