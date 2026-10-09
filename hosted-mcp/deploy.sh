#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-conmap-auto}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-armorcodex-mcp}"
DOMAIN="${DOMAIN:-armorcodex.armoriq.ai}"

echo "[deploy] project=$PROJECT_ID region=$REGION service=$SERVICE"

gcloud config set project "$PROJECT_ID"

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --no-invoker-iam-check \
  --port 8080 \
  --memory 256Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 5 \
  --timeout 300 \
  --update-env-vars "NODE_ENV=production"

echo "[deploy] service deployed. To set the domain verification token:"
echo "  gcloud run services update $SERVICE --region $REGION --update-env-vars OPENAI_DOMAIN_VERIFICATION_TOKEN=<token>"

echo "[deploy] To map the custom domain:"
echo "  gcloud beta run domain-mappings create --service $SERVICE --domain $DOMAIN --region $REGION"
echo "  Then add the CNAME / A records that gcloud prints to your DNS provider."

SERVICE_URL=$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')
echo ""
echo "[deploy] Service URL: $SERVICE_URL"
echo "[deploy] Health: curl $SERVICE_URL/health"
echo "[deploy] MCP: $SERVICE_URL/mcp"
