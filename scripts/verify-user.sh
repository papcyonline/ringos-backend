#!/bin/bash
# Usage:
#   ./scripts/verify-user.sh <email-or-name> [role]
#   ./scripts/verify-user.sh john@example.com "Pro Member"
#   ./scripts/verify-user.sh "John Doe"
#
# Time-limited verification (auto-expires; cleared by the verificationExpiry job):
#   DURATION_DAYS=90 ./scripts/verify-user.sh "John Doe"        # verified for 3 months
#   DURATION_DAYS=30 ./scripts/verify-user.sh john@example.com "Pro Member"
#   (omit DURATION_DAYS for a permanent grant)
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
  echo "  DURATION_DAYS=90 $0 <email-or-id-or-name> [role]   # verify for N days"
  echo "  UNVERIFY=1 $0 <email-or-id-or-name>                # remove verification"
  exit 1
fi

if [ "$UNVERIFY" = "1" ]; then
  VERIFIED=false
fi

BODY="{\"user\": \"$USER\", \"verified\": $VERIFIED"
if [ -n "$ROLE" ] && [ "$VERIFIED" = "true" ]; then
  BODY="$BODY, \"role\": \"$ROLE\""
fi
if [ -n "$DURATION_DAYS" ] && [ "$VERIFIED" = "true" ]; then
  BODY="$BODY, \"durationDays\": $DURATION_DAYS"
fi
BODY="$BODY}"

RESPONSE=$(curl -s -X POST "$API_URL/api/users/admin/verify" \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -d "$BODY")

echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
