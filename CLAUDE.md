# PullLeads - Lead Extraction SaaS

## Project Overview

A B2B lead extraction platform that scrapes Google Maps and other sources, enriches with owner emails (40% hit rate), and verifies emails for 90%+ deliverability.

**Stack:**
- Astro 5 with React components
- Supabase (Auth + Database)
- Stripe (Payments)
- Apify (Lead extraction backend)
- Vercel (Deployment)

## Architecture

```
src/
├── components/       # Astro components for landing page
├── layouts/          # Base layout
├── lib/              # Utilities (supabase, stripe, rate-limiter)
├── pages/
│   ├── api/          # API routes
│   │   ├── extract.ts           # Trigger lead extraction
│   │   ├── webhook/apify.ts     # Receive Apify results
│   │   ├── integrations/        # OAuth for CRMs
│   │   └── export/              # Export leads to CRMs
│   ├── auth/         # Login, callback, logout
│   ├── dashboard/    # User dashboard
│   └── index.astro   # Landing page
```

## Key Flows

### Lead Extraction
1. User submits query + location via `/dashboard/extract`
2. API deducts credits, creates extraction record
3. API triggers Apify actor with webhook URL
4. Apify sends results to `/api/webhook/apify`
5. Webhook updates extraction with leads, auto-syncs to integrations

### Integrations
- **HubSpot**: PAT-based (user enters token)
- **Salesforce**: OAuth Web Server Flow or manual token
- **Airtable**: OAuth with PKCE
- **Google Sheets**: Service account (user shares sheet)

## Database Schema

Key tables in Supabase:
- `profiles`: User plan, stripe_customer_id
- `subscriptions`: credits_remaining, period dates
- `extractions`: query, location, status, result_data (JSONB)
- `integrations`: provider, tokens, config

## Environment Variables

Required:
- `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price IDs
- `APIFY_API_TOKEN`

Optional:
- `SALESFORCE_CLIENT_ID/SECRET` (for OAuth)
- `AIRTABLE_CLIENT_ID/SECRET` (for OAuth)
- `GOOGLE_SERVICE_ACCOUNT_JSON` (for Sheets export)
- `UPSTASH_REDIS_REST_URL/TOKEN` (for production rate limiting)

## Development

```bash
npm install
npm run dev
```

## Deployment

Deployed to Vercel. See `SETUP.md` for complete configuration guide.

## Important Notes

1. **Apify Webhook**: Must be configured to send results to `/api/webhook/apify`
2. **Rate Limiting**: In-memory by default, use Redis for production
3. **Verification**: Email verification is enabled (`skipVerification: false`)
4. **Credits**: Charged upfront, refunded if extraction fails or returns fewer leads
