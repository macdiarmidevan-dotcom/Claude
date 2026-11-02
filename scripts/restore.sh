#!/bin/sh
# Loads a backup made by backup.sh into the database, replacing what's there.
#   DATABASE_URL=postgres://... scripts/restore.sh backups/golf-20261101-020000.sql.gz
set -eu
FILE="${1:?give the backup file to restore}"
: "${DATABASE_URL:?set DATABASE_URL}"
echo "This replaces everything in the database with $FILE. Press Enter to continue, Ctrl-C to stop."
read -r _
gunzip -c "$FILE" | psql --set ON_ERROR_STOP=1 "$DATABASE_URL" > /dev/null
echo "Restored $FILE"
