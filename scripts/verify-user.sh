#!/bin/bash
# Usage:
#   ./scripts/verify-user.sh <email-or-name> [role]
#   ./scripts/verify-user.sh john@example.com "Pro Member"
#   ./scripts/verify-user.sh "John Doe"
#
# To REMOVE verification:
#   UNVERIFY=1 ./scripts/verify-user.sh john@example.com

set -e

API_URL="${API_URL:-http://localhost:3000}"
ADMIN_SECRET="${ADMIN_SECRET:-yomeet-admin-2024-change-me}"

USER="$1"
ROLE="$2"
VERIFIED=true

if [ -z "$USER" ]; then
  echo "Usage: $0 <email-or-id-or-name> [role]"
  echo "  UNVERIFY=1 $0 <email-or-id-or-name>   # remove verification"
  exit 1
fi

if [ "$UNVERIFY" = "1" ]; then
  VERIFIED=false
fi

BODY="{\"user\": \"$USER\", \"verified\": $VERIFIED"
if [ -n "$ROLE" ] && [ "$VERIFIED" = "true" ]; then
  BODY="$BODY, \"role\": \"$ROLE\""
fi
BODY="$BODY}"

RESPONSE=$(curl -s -X POST "$API_URL/api/users/admin/verify" \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "$BODY")

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
