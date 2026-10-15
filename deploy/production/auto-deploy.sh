#!/bin/sh
# Polls GitHub for new commits on main and rebuilds webapp + ocr when it changes.
# The backend is Supabase cloud, so there are no local migrations to run here.
# Runs on a timer (see kiyometa-autodeploy.timer) — no public webhook needed.
#
# The deployed commit is recorded in $STATE only after a successful build, so a
# failed build is retried on the next tick instead of being silently skipped.
set -eu

APP_DIR=/srv/kiyometa/app
DEPLOY_DIR=/srv/kiyometa/deploy
STATE=/srv/kiyometa/deploy/.deployed-commit
LOG=/var/log/kiyometa-autodeploy.log
LOCK=/tmp/kiyometa-autodeploy.lock

log() { echo "$(date -Is) $*" >> "$LOG"; }

# Never run two deploys at once.
exec 9>"$LOCK"
flock -n 9 || exit 0

cd "$APP_DIR"
if ! git fetch -q origin main 2>>"$LOG"; then
  log "git fetch failed (network?), will retry"
  exit 0
fi

REMOTE=$(git rev-parse origin/main)
DEPLOYED=$(cat "$STATE" 2>/dev/null || true)

[ "$DEPLOYED" = "$REMOTE" ] && exit 0

log "deploying ${DEPLOYED:-none} -> $REMOTE"
git reset -q --hard origin/main >> "$LOG" 2>&1

cd "$DEPLOY_DIR"
# The ocr service builds from ./ocr-fix, which only layers system libs on top of
# kiyometa-ocr:latest — so that base image must be rebuilt from the repo first,
# otherwise ocr-service changes never reach the running container.
if docker build -q -t kiyometa-ocr:latest "$APP_DIR/ocr-service" >> "$LOG" 2>&1 \
   && docker compose up -d --build --no-deps orders-webapp ocr >> "$LOG" 2>&1; then
  echo "$REMOTE" > "$STATE"
  docker image prune -f >> "$LOG" 2>&1 || true
  log "deploy done"
else
  log "deploy FAILED for $REMOTE, will retry next tick"
  exit 1
fi
