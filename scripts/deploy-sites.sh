#!/usr/bin/env bash
# Builds the wcvm sites and uploads them to their Cloudflare Pages projects (a "direct upload": nothing here
# redeploys on a git push, so run this after changing a site).
#
#   bash scripts/deploy-sites.sh                # all three
#   bash scripts/deploy-sites.sh docs studio    # only some
#
# Needs a Cloudflare login (`npx wrangler@3 login`) or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
#
# Pinned to wrangler 3: wrangler 4 refuses `pages project create` / `pages deploy` here because it first tries to
# register a workers.dev subdomain on the account, which a Pages project does not need.
set -euo pipefail
cd "$(dirname "$0")/.."

# Plain `case`, not associative arrays: macOS still ships bash 3.2.
site_config() { # sets PROJECT, DIST and FILTER for $1
  case "$1" in
    landing) PROJECT=wcvm-landing; DIST=apps/landing/dist;            FILTER='wcvm-landing...' ;;
    docs)    PROJECT=wcvm-docs;    DIST=apps/docs/.vitepress/dist;    FILTER='wcvm-docs...' ;;
    studio)  PROJECT=wcvm-studio;  DIST=apps/studio/dist;             FILTER='studio...' ;;
    *) echo "unknown site '$1' (landing, docs, studio)" >&2; exit 2 ;;
  esac
}

SITES=("$@")
[ ${#SITES[@]} -eq 0 ] && SITES=(landing docs studio)

for site in "${SITES[@]}"; do
  site_config "$site"
  echo "== $site: build"
  pnpm --filter "$FILTER" build
  echo "== $site: upload to $PROJECT"
  npx --yes wrangler@3 pages deploy "$DIST" --project-name "$PROJECT" --branch main \
    --commit-message "Deploy $(git rev-parse --short HEAD)"
done
