import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

// Lazy initialization
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

  try {
    const body = await request.json();

    // Apify sends different event types
    const { eventType, eventData, resource } = body;

    // Handle both direct webhook and Apify webhook format
    const runId = resource?.id || eventData?.actorRunId || body.runId;
    const status = resource?.status || eventData?.status || body.status;

    if (!runId) {
      return new Response(JSON.stringify({ error: 'Missing run ID' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Find the extraction by apify_run_id
    const { data: extraction, error: findError } = await supabaseClient
      .from('extractions')
      .select('*')
      .eq('apify_run_id', runId)
      .single();

    if (findError || !extraction) {
      console.log('Extraction not found for run ID:', runId);
      return new Response(JSON.stringify({ message: 'Extraction not found' }), {
        status: 200, // Return 200 to prevent Apify from retrying
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle different statuses
    if (status === 'SUCCEEDED' || eventType === 'ACTOR.RUN.SUCCEEDED') {
      // Fetch results from Apify
      const APIFY_API_TOKEN = import.meta.env.APIFY_API_TOKEN;

      const resultsResponse = await fetch(
        `https://api.apify.com/v2/actor-runs/${runId}/dataset/items?token=${APIFY_API_TOKEN}&format=json`,
        { method: 'GET' }
      );

      if (!resultsResponse.ok) {
        throw new Error('Failed to fetch results from Apify');
      }

      const leads = await resultsResponse.json();
      const leadsCount = Array.isArray(leads) ? leads.length : 0;

      // Calculate actual credits used (we may have overcharged)
      const creditsUsed = extraction.credits_used;
      const actualLeads = leadsCount;

      // If we got fewer leads than charged, refund the difference
      if (actualLeads < creditsUsed) {
        const refundAmount = creditsUsed - actualLeads;
        await supabaseClient
          .from('subscriptions')
          .update({
            credits_remaining: supabaseClient.rpc('credits_remaining') + refundAmount,
          })
          .eq('user_id', extraction.user_id);

        // Alternative: Direct SQL update
        await supabaseClient.rpc('refund_credits', {
          p_user_id: extraction.user_id,
          p_amount: refundAmount
        });
      }

      // Update extraction with results
      const { error: updateError } = await supabaseClient
        .from('extractions')
        .update({
          status: 'completed',
          leads_count: leadsCount,
          result_data: { leads },
          completed_at: new Date().toISOString(),
          credits_used: actualLeads, // Update to actual credits used
        })
        .eq('id', extraction.id);

      if (updateError) {
        console.error('Failed to update extraction:', updateError);
        throw updateError;
      }

      // Send to user's webhook if configured
      if (extraction.webhook_url) {
        try {
          await fetch(extraction.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              extractionId: extraction.id,
              query: extraction.query,
              location: extraction.location,
              leadsCount,
              leads,
              status: 'completed',
            }),
          });
        } catch (webhookError) {
          console.error('Failed to send to user webhook:', webhookError);
          // Don't fail the whole request for webhook errors
        }
      }

      // Auto-sync to connected integrations
      await syncToIntegrations(supabaseClient, extraction.user_id, leads);

      return new Response(JSON.stringify({
        success: true,
        leadsCount,
        extractionId: extraction.id
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    } else if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT' ||
               eventType === 'ACTOR.RUN.FAILED' || eventType === 'ACTOR.RUN.ABORTED' || eventType === 'ACTOR.RUN.TIMED_OUT') {

      // Mark as failed and refund credits
      await supabaseClient
        .from('extractions')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
        })
        .eq('id', extraction.id);

      // Refund all credits
      await supabaseClient.rpc('refund_credits', {
        p_user_id: extraction.user_id,
        p_amount: extraction.credits_used
      });

      // Notify user webhook if configured
      if (extraction.webhook_url) {
        try {
          await fetch(extraction.webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              extractionId: extraction.id,
              status: 'failed',
              error: 'Extraction failed or timed out',
            }),
          });
        } catch (webhookError) {
          console.error('Failed to send to user webhook:', webhookError);
        }
      }

      return new Response(JSON.stringify({
        success: true,
        message: 'Extraction marked as failed, credits refunded'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // For other events (RUNNING, etc.), just acknowledge
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Apify webhook error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// Helper function to auto-sync to user's connected integrations
async function syncToIntegrations(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  leads: any[]
) {
  try {
    // Get user's active integrations
    const { data: integrations } = await supabase
      .from('integrations')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true);

    if (!integrations || integrations.length === 0) return;

    for (const integration of integrations) {
      try {
        switch (integration.provider) {
          case 'hubspot':
            await syncToHubSpot(integration.access_token, leads);
            break;
          case 'google_sheets':
            // Sheets sync requires Google API setup
            break;
          // Add more integrations as needed
        }
      } catch (integrationError) {
        console.error(`Failed to sync to ${integration.provider}:`, integrationError);
        // Continue with other integrations
      }
    }
  } catch (error) {
    console.error('Integration sync error:', error);
  }
}

async function syncToHubSpot(accessToken: string, leads: any[]) {
  // Batch create contacts in HubSpot (max 100 per request)
  const batchSize = 100;

  for (let i = 0; i < leads.length; i += batchSize) {
    const batch = leads.slice(i, i + batchSize);

    const contacts = batch.map(lead => ({
      properties: {
        email: lead.email || '',
        firstname: (lead.ownerName || lead.owner_name || '').split(' ')[0] || '',
        lastname: (lead.ownerName || lead.owner_name || '').split(' ').slice(1).join(' ') || '',
        company: lead.name || lead.businessName || lead.business_name || '',
        phone: lead.phone || '',
        website: lead.website || '',
        address: lead.address || lead.fullAddress || lead.full_address || '',
        jobtitle: lead.ownerTitle || lead.owner_title || '',
      }
    }));

    // Only sync contacts that have an email
    const validContacts = contacts.filter(c => c.properties.email);

    if (validContacts.length === 0) continue;

    await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/create', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ inputs: validContacts }),
    });
  }
}
