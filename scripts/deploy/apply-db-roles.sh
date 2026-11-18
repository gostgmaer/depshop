#!/usr/bin/env bash
# Creates/updates the least-privilege database roles (idempotent; after migrations).
# Passwords are passed to the container as environment variables (not argv).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

APP_PW="$(env_get DEALMIND_APP_DB_PASSWORD)"
AGENT_PW="$(env_get DEALMIND_AGENT_DB_PASSWORD)"
[[ -n "$APP_PW" && -n "$AGENT_PW" ]] || die "DEALMIND_APP_DB_PASSWORD and DEALMIND_AGENT_DB_PASSWORD are required"
export APP_PW AGENT_PW

dc exec -T -e APP_PW -e AGENT_PW postgres sh -c \
  'psql -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -v app_password="$APP_PW" -v agent_password="$AGENT_PW" -f /opt/dealmind/roles.sql' >/dev/null
log "database roles applied (dealmind_app, dealmind_agent)"
