import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import { checkRateLimit, rateLimitErrorResponse, rateLimitHeaders, RATE_LIMITS } from '../../lib/rate-limiter';

// Lazy initialization to avoid build-time errors
let supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (!supabase && import.meta.env.PUBLIC_SUPABASE_URL) {
    supabase = createClient(
      import.meta.env.PUBLIC_SUPABASE_URL,
      import.meta.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return supabase;
}

export const POST: APIRoute = async ({ request }) => {
  const supabaseClient = getSupabase();

  if (!supabaseClient) {
    return new Response(JSON.stringify({ error: 'Service not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const APIFY_API_TOKEN = import.meta.env.APIFY_API_TOKEN;
  const APIFY_ACTOR_ID = import.meta.env.APIFY_ACTOR_ID || 'U1NdkcLzWXOfhQ7iM';

  try {
    // Get auth token from header
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.slice(7);

    // Verify the token
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Rate limiting per user
    const rateLimitResult = checkRateLimit(user.id, RATE_LIMITS.extract);
    if (!rateLimitResult.allowed) {
      return rateLimitErrorResponse(rateLimitResult);
    }

    // Get request body
    const body = await request.json();
    const { query, niche, location, source, limit, enrichMode, webhookUrl } = body;

    if (!location) {
      return new Response(JSON.stringify({ error: 'Location is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!query && !niche) {
      return new Response(JSON.stringify({ error: 'Query or niche is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const leadsRequested = Math.min(limit || 50, 500);

    // Check user's credits
    const { data: subscription, error: subError } = await supabaseClient
      .from('subscriptions')
      .select('credits_remaining')
      .eq('user_id', user.id)
      .single();

    if (subError || !subscription) {
      return new Response(JSON.stringify({ error: 'No subscription found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (subscription.credits_remaining < leadsRequested) {
      return new Response(JSON.stringify({
        error: `Insufficient credits. You have ${subscription.credits_remaining} credits, but requested ${leadsRequested} leads.`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Deduct credits
    const { error: deductError } = await supabaseClient
      .from('subscriptions')
      .update({
        credits_remaining: subscription.credits_remaining - leadsRequested
      })
      .eq('user_id', user.id);

    if (deductError) {
      return new Response(JSON.stringify({ error: 'Failed to deduct credits' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create extraction record
    const { data: extraction, error: insertError } = await supabaseClient
      .from('extractions')
      .insert({
        user_id: user.id,
        query: query || niche,
        location,
        source: source || 'google_maps',
        leads_count: null,
        credits_used: leadsRequested,
        status: 'pending',
        webhook_url: webhookUrl,
      })
      .select()
      .single();

    if (insertError || !extraction) {
      // Refund credits
      await supabaseClient
        .from('subscriptions')
        .update({
          credits_remaining: subscription.credits_remaining
        })
        .eq('user_id', user.id);

      return new Response(JSON.stringify({ error: 'Failed to create extraction' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Trigger Apify actor
    const apifyInput = {
      query: query || undefined,
      niche: niche || undefined,
      location,
      source: source || 'google_maps',
      limit: leadsRequested,
      enrichMode: enrichMode || 'name-search',
      skipEnrichment: false,
      skipVerification: false, // Enable email verification for 90%+ deliverability
      // Configure webhook for async results
      webhookUrl: `${new URL(request.url).origin}/api/webhook/apify`,
    };

    try {
      const apifyResponse = await fetch(
        `https://api.apify.com/v2/acts/${APIFY_ACTOR_ID}/runs?token=${APIFY_API_TOKEN}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(apifyInput),
        }
      );

      if (!apifyResponse.ok) {
        throw new Error('Failed to start Apify actor');
      }

      const apifyResult = await apifyResponse.json();
      const runId = apifyResult.data?.id;

      // Update extraction with run ID
      await supabaseClient
        .from('extractions')
        .update({
          status: 'running',
          apify_run_id: runId,
        })
        .eq('id', extraction.id);

      return new Response(JSON.stringify({
        success: true,
        extractionId: extraction.id,
        runId,
        creditsUsed: leadsRequested,
        creditsRemaining: subscription.credits_remaining - leadsRequested,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...rateLimitHeaders(rateLimitResult),
        },
      });

    } catch (apifyError) {
      // Mark extraction as failed
      await supabaseClient
        .from('extractions')
        .update({ status: 'failed' })
        .eq('id', extraction.id);

      // Refund credits
      await supabaseClient
        .from('subscriptions')
        .update({
          credits_remaining: subscription.credits_remaining
        })
        .eq('user_id', user.id);

      return new Response(JSON.stringify({ error: 'Failed to start extraction' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

  } catch (error: any) {
    console.error('Extract error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
