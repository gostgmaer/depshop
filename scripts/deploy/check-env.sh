#!/usr/bin/env bash
# Validates the production/staging env file before a deployment.
# Prints only variable NAMES, never values. Exit 1 on any problem.
#
#   ENV_FILE=/opt/dealmind/.env.production scripts/deploy/check-env.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"
perm="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 600)"
[[ "$perm" =~ ^[0-7]00$ ]] || log "WARNING: $ENV_FILE is mode $perm; use chmod 600"

problems=0
need() { # need NAME [min_length]
  local v; v="$(env_get "$1")"
  if [[ -z "$v" ]]; then log "missing: $1"; problems=$((problems + 1)); return; fi
  if [[ -n "${2:-}" && ${#v} -lt $2 ]]; then log "too short (< $2): $1"; problems=$((problems + 1)); fi
  if [[ "$v" == *example.invalid* || "$v" == *CHANGE_ME* || "$v" == OWNER || "$v" == *"/OWNER"* ]]; then
    log "placeholder value: $1"; problems=$((problems + 1))
  fi
}
url_safe() { # values embedded in connection strings must not need URL-encoding
  local v; v="$(env_get "$1")"
  [[ -z "$v" || "$v" =~ ^[A-Za-z0-9._~-]+$ ]] || { log "not URL-safe (use openssl rand -hex 32): $1"; problems=$((problems + 1)); }
}

deploy_env="$(env_get DEPLOY_ENV)"
[[ "$deploy_env" == "production" || "$deploy_env" == "staging" ]] || { log "DEPLOY_ENV must be staging or production"; problems=$((problems + 1)); }

for v in APP_DOMAIN API_DOMAIN ACME_EMAIL IMAGE_REGISTRY IAM_BASE_URL LLM_MODEL; do need "$v"; done
for v in POSTGRES_PASSWORD DEALMIND_APP_DB_PASSWORD DEALMIND_AGENT_DB_PASSWORD REDIS_PASSWORD \
         SESSION_SECRET INTERNAL_API_TOKEN AGENT_SERVICE_TOKEN AGENT_USER_CONTEXT_SECRET; do need "$v" 32; done
need TOKEN_ENCRYPTION_KEY 40
for v in POSTGRES_PASSWORD DEALMIND_APP_DB_PASSWORD DEALMIND_AGENT_DB_PASSWORD REDIS_PASSWORD; do url_safe "$v"; done

# Distinct secrets: one leaked token must not unlock another boundary.
secrets=(POSTGRES_PASSWORD DEALMIND_APP_DB_PASSWORD DEALMIND_AGENT_DB_PASSWORD REDIS_PASSWORD SESSION_SECRET
         INTERNAL_API_TOKEN AGENT_SERVICE_TOKEN AGENT_USER_CONTEXT_SECRET METRICS_TOKEN PAYMENT_WEBHOOK_SECRET)
dupes="$(
  for s in "${secrets[@]}"; do
    v="$(env_get "$s")"
    if [[ -n "$v" ]]; then printf '%s\n' "$(printf '%s' "$v" | sha256sum | cut -c1-16)"; fi
  done | sort | uniq -d
)"
[[ -z "$dupes" ]] || { log "two or more secrets share the same value; generate each separately"; problems=$((problems + 1)); }

[[ "$(env_get APP_DOMAIN)" != "$(env_get API_DOMAIN)" ]] || { log "APP_DOMAIN and API_DOMAIN must differ"; problems=$((problems + 1)); }

provider="$(env_get LLM_PROVIDER)"
case "${provider:-google}" in
  google) need GOOGLE_API_KEY ;;
  openai) need OPENAI_API_KEY ;;
  rules)
    # The agent refuses the rule-based extractor with NODE_ENV=production (a dev aid).
    if [[ "${ALLOW_RULES_LLM:-0}" == "1" ]]; then
      log "LLM_PROVIDER=rules allowed by ALLOW_RULES_LLM=1 (local rehearsal only)"
    else
      log "LLM_PROVIDER=rules is not allowed for staging/production (configure google or openai)"; problems=$((problems + 1))
    fi ;;
  *) log "unknown LLM_PROVIDER"; problems=$((problems + 1)) ;;
esac

if [[ "$(env_get BILLING_PROVIDER)" == "easydev-payments" ]]; then
  for v in PAYMENT_SERVICE_URL PAYMENT_SERVICE_API_KEY PAYMENT_WEBHOOK_SECRET; do need "$v"; done
fi
[[ "$(env_get BILLING_PROVIDER)" != "sandbox" ]] || { log "BILLING_PROVIDER=sandbox is not allowed outside development"; problems=$((problems + 1)); }

# Launch gates that don't block staging but must be set for production.
if [[ "$deploy_env" == "production" ]]; then
  for v in PRIVACY_OPERATOR_NAME PRIVACY_CONTACT_EMAIL; do
    [[ -n "$(env_get "$v")" ]] || { log "missing (required for production launch): $v"; problems=$((problems + 1)); }
  done
  [[ -n "$(env_get BACKUP_AGE_RECIPIENT)" ]] || log "WARNING: BACKUP_AGE_RECIPIENT empty: backups will not be encrypted at rest"
  [[ -z "$(env_get ACME_CA_SERVER)" || "$(env_get ACME_CA_SERVER)" != *staging* ]] || log "WARNING: ACME staging CA in production (browsers will not trust the certificate)"
fi

for v in AMAZON_CREATORS_CREDENTIAL_ID FLIPKART_AFFILIATE_ID; do
  [[ -n "$(env_get "$v")" ]] || log "info: $v empty: that marketplace stays PENDING_CREDENTIALS (not searched)"
done

if (( problems > 0 )); then die "$problems problem(s) in $ENV_FILE"; fi
log "env OK ($deploy_env)"
