#!/usr/bin/env bash
# Post-deployment smoke tests: in-network checks through Docker (readiness of
# API with DB + Redis, agent readiness, worker heartbeat), then the public
# HTTPS checks in smoke.mjs. Called by deploy.sh and rollback.sh.
#
# Env: APP_URL / API_URL (default https://APP_DOMAIN / https://API_DOMAIN),
#      SMOKE_EMAIL / SMOKE_PASSWORD (dedicated test account; read from the env file),
#      SMOKE_INSECURE=1 (self-signed certificate rehearsal only).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../deploy/lib.sh
source "$here/../deploy/lib.sh"
export IMAGE_TAG="${IMAGE_TAG:-$(current_release)}"
fail=0

log "internal: api /ready (database + redis)"
# Every critical readiness check must be "ok", except those listed in
# SMOKE_IGNORE_CHECKS (rehearsals without a shared dependency, e.g. "iam,iamJwks").
if ready="$(dc exec -T -e SMOKE_IGNORE_CHECKS="${SMOKE_IGNORE_CHECKS:-}" api node -e "fetch('http://127.0.0.1:4000/ready').then(async r=>{const b=await r.json();const skip=(process.env.SMOKE_IGNORE_CHECKS||'').split(',').filter(Boolean);console.log(JSON.stringify(b.checks));process.exit(Object.entries(b.checks).every(([k,v])=>v==='ok'||skip.includes(k))&&b.checks.database==='ok'&&b.checks.redis==='ok'?0:1)}).catch(()=>process.exit(1))")"; then
  log "  ok $ready"
else
  log "  FAIL api not ready: $ready"; fail=1
fi

log "internal: agent /ready"
if dc exec -T agent python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/ready', timeout=3).status == 200 else 1)"; then
  log "  ok"
else
  log "  FAIL agent not ready"; fail=1
fi

log "internal: worker heartbeat"
wid="$(dc ps -q worker | head -n 1)"
if [[ -n "$wid" && "$(docker inspect -f '{{.State.Health.Status}}' "$wid")" == "healthy" ]]; then
  log "  ok"
else
  log "  FAIL worker not healthy"; fail=1
fi

APP_URL="${APP_URL:-https://$(env_get APP_DOMAIN)}"
API_URL="${API_URL:-https://$(env_get API_DOMAIN)}"
SMOKE_EMAIL="${SMOKE_EMAIL:-$(env_get SMOKE_EMAIL)}"
SMOKE_PASSWORD="${SMOKE_PASSWORD:-$(env_get SMOKE_PASSWORD)}"
export APP_URL API_URL SMOKE_EMAIL SMOKE_PASSWORD

log "public checks against $APP_URL and $API_URL"
# Native path for docker -v (Git Bash on Windows; a no-op on Linux).
script_src="$here/smoke.mjs"
command -v cygpath >/dev/null && script_src="$(cygpath -w "$script_src")"
if [[ "${SMOKE_RUNNER:-}" == "edge" ]]; then
  # From inside the edge network with the domains pinned to Traefik: tests the
  # real routing/TLS without depending on public DNS (new servers, rehearsals).
  tid="$(dc ps -q traefik | head -n 1)"
  tip="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{if eq $k "dealmind-edge"}}{{$v.IPAddress}}{{end}}{{end}}' "$tid")"
  [[ -n "$tip" ]] || die "could not find Traefik on dealmind-edge"
  app_host="$(env_get APP_DOMAIN)"; api_host="$(env_get API_DOMAIN)"
  MSYS_NO_PATHCONV=1 docker run --rm --network dealmind-edge --add-host "$app_host:$tip" --add-host "$api_host:$tip" \
    -e APP_URL="https://$app_host" -e API_URL="https://$api_host" -e SMOKE_EMAIL -e SMOKE_PASSWORD -e SMOKE_INSECURE \
    -v "$script_src:/smoke.mjs:ro" node:22.23.5-bookworm-slim node /smoke.mjs || fail=1
elif command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)'; then
  node "$here/smoke.mjs" || fail=1
else
  # No suitable Node on the host: run the script in the pinned Node image (host network for DNS/HTTPS).
  MSYS_NO_PATHCONV=1 docker run --rm --network host -e APP_URL -e API_URL -e SMOKE_EMAIL -e SMOKE_PASSWORD -e SMOKE_INSECURE \
    -v "$script_src:/smoke.mjs:ro" node:22.23.5-bookworm-slim node /smoke.mjs || fail=1
fi

(( fail == 0 )) || die "smoke tests failed"
log "smoke tests passed"
