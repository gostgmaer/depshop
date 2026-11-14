#!/bin/sh
# Pre-registers the DealMind PostgreSQL server in pgAdmin using values from the
# environment, so no credentials live in the repository. Then hands off to the
# stock pgAdmin entrypoint.
set -eu

# servers.json is only imported on pgAdmin's first launch (empty volume).
cat > /tmp/servers.json <<JSON
{
  "Servers": {
    "1": {
      "Name": "DealMind (local)",
      "Group": "DealMind",
      "Host": "postgres",
      "Port": 5432,
      "MaintenanceDB": "${POSTGRES_DB}",
      "Username": "${POSTGRES_USER}",
      "SSLMode": "prefer",
      "PassFile": "/pgpass"
    }
  }
}
JSON
export PGADMIN_SERVER_JSON_FILE=/tmp/servers.json

# In server mode, PassFile is resolved relative to the user's storage
# directory, whose name is the login email with "@" replaced by "_".
storage_dir="/var/lib/pgadmin/storage/$(echo "$PGADMIN_DEFAULT_EMAIL" | sed 's/@/_/')"
mkdir -p "$storage_dir"
printf 'postgres:5432:*:%s:%s\n' "$POSTGRES_USER" "$POSTGRES_PASSWORD" > "$storage_dir/pgpass"
chmod 600 "$storage_dir/pgpass"

exec /entrypoint.sh "$@"
