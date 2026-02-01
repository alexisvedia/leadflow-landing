# PullLeads - Setup Guide

Complete guide to configure all integrations and deploy to production.

## Table of Contents

1. [Environment Variables](#environment-variables)
2. [Supabase Setup](#supabase-setup)
3. [Stripe Setup](#stripe-setup)
4. [Apify Setup](#apify-setup)
5. [Salesforce Integration](#salesforce-integration)
6. [Airtable Integration](#airtable-integration)
7. [Google Sheets Integration](#google-sheets-integration)
8. [Redis (Optional)](#redis-optional)
9. [Deployment](#deployment)

---

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Supabase (Required)
PUBLIC_SUPABASE_URL=https://your-project.supabase.co
PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...

# Stripe (Required)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_GROWTH=price_...
STRIPE_PRICE_SCALE=price_...

# Apify (Required)
APIFY_API_TOKEN=apify_api_...
APIFY_ACTOR_ID=U1NdkcLzWXOfhQ7iM

# Salesforce (Optional - for OAuth)
SALESFORCE_CLIENT_ID=
SALESFORCE_CLIENT_SECRET=

# Airtable (Optional - for OAuth)
AIRTABLE_CLIENT_ID=
AIRTABLE_CLIENT_SECRET=

# Google Sheets (Optional)
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}

# Redis (Optional - for production rate limiting)
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
```

---

## Supabase Setup

### 1. Create Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Copy your project URL and anon key from Settings > API

### 2. Run Database Schema

1. Go to SQL Editor in Supabase Dashboard
2. Copy and paste the contents of `supabase-schema.sql`
3. Click "Run"

### 3. Configure Authentication

1. Go to Authentication > Providers
2. Enable **Email** with these settings:
   - Enable "Email confirmations"
   - Set "Site URL" to your production URL
   - Add callback URLs: `https://yourdomain.com/auth/callback`

3. Enable **Google** (optional):
   - Create OAuth credentials in Google Cloud Console
   - Add Client ID and Secret
   - Add callback URL: `https://yourdomain.com/auth/callback`

### 4. Update for Migrations

If updating an existing installation, run:

```sql
-- From supabase-migration.sql
ALTER TABLE public.integrations DROP CONSTRAINT IF EXISTS integrations_provider_check;
ALTER TABLE public.integrations ADD CONSTRAINT integrations_provider_check
  CHECK (provider IN ('hubspot', 'google_sheets', 'webhook', 'salesforce', 'airtable'));
```

---

## Stripe Setup

### 1. Create Products & Prices

In Stripe Dashboard > Products:

1. **Starter Plan** - $49/month
   - Create product named "Starter"
   - Add recurring price: $49/month
   - Copy price ID → `STRIPE_PRICE_STARTER`

2. **Growth Plan** - $99/month
   - Create product named "Growth"
   - Add recurring price: $99/month
   - Copy price ID → `STRIPE_PRICE_GROWTH`

3. **Scale Plan** - $249/month
   - Create product named "Scale"
   - Add recurring price: $249/month
   - Copy price ID → `STRIPE_PRICE_SCALE`

### 2. Configure Webhook

1. Go to Developers > Webhooks
2. Add endpoint: `https://yourdomain.com/api/stripe-webhook`
3. Select events:
   - `checkout.session.completed`
   - `invoice.payment_succeeded`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy signing secret → `STRIPE_WEBHOOK_SECRET`

### 3. Get API Keys

1. Go to Developers > API Keys
2. Copy Secret key → `STRIPE_SECRET_KEY`
3. Copy Publishable key → `PUBLIC_STRIPE_PUBLISHABLE_KEY`

---

## Apify Setup

### 1. Get API Token

1. Go to [apify.com](https://apify.com) and sign up
2. Go to Settings > Integrations
3. Create new API token → `APIFY_API_TOKEN`

### 2. Configure Actor Webhook (Important!)

The actor must send results back via webhook:

1. Go to your actor's settings
2. Add webhook with URL: `https://yourdomain.com/api/webhook/apify`
3. Set event types: `ACTOR.RUN.SUCCEEDED`, `ACTOR.RUN.FAILED`

Alternatively, configure in actor input:
```json
{
  "webhookUrl": "https://yourdomain.com/api/webhook/apify"
}
```

### 3. Actor ID

The default actor ID is `U1NdkcLzWXOfhQ7iM`. If using a custom actor, update `APIFY_ACTOR_ID`.

---

## Salesforce Integration

Users can connect via OAuth or manual token entry.

### Option A: OAuth (Recommended)

#### 1. Create Connected App

1. Log into Salesforce Setup
2. Go to App Manager > New Connected App
3. Fill in:
   - Connected App Name: "PullLeads"
   - API Name: "PullLeads"
   - Contact Email: your email
4. Enable OAuth Settings:
   - Callback URL: `https://yourdomain.com/api/integrations/salesforce`
   - Scopes: "Manage user data via APIs (api)", "Perform requests at any time (refresh_token)"
5. Save and wait 10 minutes for propagation
6. Copy Consumer Key → `SALESFORCE_CLIENT_ID`
7. Copy Consumer Secret → `SALESFORCE_CLIENT_SECRET`

### Option B: Manual (PAT/Access Token)

Users can also connect manually with:
- Instance URL (e.g., `https://yourorg.salesforce.com`)
- Access Token from their session

---

## Airtable Integration

### 1. Create OAuth Integration

1. Go to [airtable.com/create/oauth](https://airtable.com/create/oauth)
2. Create new integration:
   - Name: "PullLeads"
   - Redirect URL: `https://yourdomain.com/api/integrations/airtable`
3. Select scopes:
   - `data.records:read`
   - `data.records:write`
   - `schema.bases:read`
4. Copy Client ID → `AIRTABLE_CLIENT_ID`
5. Copy Client Secret (if using confidential client) → `AIRTABLE_CLIENT_SECRET`

### 2. User Flow

When users connect:
1. They authorize access to their bases
2. They select which base to use
3. Leads are exported to a "Leads" table (auto-created if needed)

---

## Google Sheets Integration

### 1. Create Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project or select existing
3. Enable Google Sheets API
4. Go to IAM & Admin > Service Accounts
5. Create service account:
   - Name: "PullLeads Sheets"
   - Role: None (we'll use sharing)
6. Create key (JSON format)
7. Copy the entire JSON → `GOOGLE_SERVICE_ACCOUNT_JSON`

### 2. User Instructions

Users must share their spreadsheet with the service account email:
```
pulleads@your-project.iam.gserviceaccount.com
```

(Replace with your actual service account email from the JSON)

---

## Redis (Optional)

For production rate limiting with horizontal scaling, add Redis.

### Upstash (Recommended for Vercel)

1. Go to [upstash.com](https://upstash.com) and create a Redis database
2. Copy REST URL → `UPSTASH_REDIS_REST_URL`
3. Copy Token → `UPSTASH_REDIS_REST_TOKEN`

The rate limiter will automatically use Redis if configured, otherwise falls back to in-memory.

---

## Deployment

### Vercel (Recommended)

1. Connect your repository to Vercel
2. Add all environment variables in Project Settings
3. Deploy

### Environment-Specific URLs

Update these URLs for production:
- Stripe webhook: `https://yourdomain.com/api/stripe-webhook`
- Apify webhook: `https://yourdomain.com/api/webhook/apify`
- OAuth callbacks: `https://yourdomain.com/api/integrations/{provider}`
- Supabase Site URL: `https://yourdomain.com`
- Supabase Redirect URLs: `https://yourdomain.com/auth/callback`

### Post-Deployment Checklist

- [ ] Run database migrations
- [ ] Configure Stripe webhook
- [ ] Configure Apify webhook
- [ ] Test email login
- [ ] Test Google OAuth (if enabled)
- [ ] Test payment flow
- [ ] Test lead extraction
- [ ] Test integrations (HubSpot, Salesforce, Airtable, Sheets)

---

## Troubleshooting

### Extraction not completing

1. Check Apify webhook is configured correctly
2. Verify `APIFY_API_TOKEN` is valid
3. Check Supabase logs for webhook errors

### Integration OAuth failing

1. Verify callback URLs match exactly
2. Check client ID/secret are correct
3. For Salesforce, wait 10 minutes after creating Connected App

### Rate limiting issues

1. In-memory rate limiting resets on deploy
2. Use Redis for persistent rate limits in production

### Stripe webhook not working

1. Verify webhook URL is accessible
2. Check signing secret matches
3. Test with Stripe CLI: `stripe listen --forward-to localhost:4321/api/stripe-webhook`
