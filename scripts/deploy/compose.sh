#!/usr/bin/env bash
# `docker compose` for the production stack with the right files and env:
#   scripts/deploy/compose.sh ps | logs -f api | exec api sh ...
# IMAGE_TAG defaults to the currently deployed release.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"
IMAGE_TAG="${IMAGE_TAG:-$(current_release)}"
export IMAGE_TAG="${IMAGE_TAG:-unset}"
dc "$@"
