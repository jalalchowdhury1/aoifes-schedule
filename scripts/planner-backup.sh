#!/bin/bash
# Nightly snapshot of both aoifes-schedule KV blobs into Google Drive.
# Runs from launchd at 03:40 (overnight window per house convention).
set -u
DRIVE="$HOME/Library/CloudStorage/GoogleDrive-jalal.chowdhury@gmail.com/My Drive"
DEST="$DRIVE/Aoife Planner Backups"
mkdir -p "$DEST"
D=$(date +%F)
ok=1
for pair in "get:schedule" "plan-get:plan"; do
  ep="${pair%%:*}"; name="${pair##*:}"
  out="$DEST/$D-$name.json"
  if curl -sf --max-time 60 "https://aoifes-schedule.vercel.app/api/$ep" -o "$out" \
     && python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$out"; then
    :
  else
    ok=0; echo "PLANNER-BACKUP FAIL $D $name"
  fi
done
[ "$ok" = 1 ] && echo "PLANNER-BACKUP OK $D"
