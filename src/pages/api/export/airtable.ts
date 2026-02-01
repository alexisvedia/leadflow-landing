import type { APIRoute } from 'astro';
import { getSupabaseServer } from '../../../lib/supabase-server';

export const POST: APIRoute = async ({ request }) => {
  const supabase = getSupabaseServer();

  if (!supabase) {
    return new Response(JSON.stringify({ error: 'Service not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Auth check
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const token = authHeader.slice(7);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get Airtable integration
    const { data: integration } = await supabase
      .from('integrations')
      .select('*')
      .eq('user_id', user.id)
      .eq('provider', 'airtable')
      .eq('is_active', true)
      .single();

    if (!integration) {
      return new Response(JSON.stringify({ error: 'Airtable not connected. Please connect it first.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check if token is expired and refresh if needed
    let accessToken = integration.access_token;
    if (integration.token_expires_at && new Date(integration.token_expires_at) < new Date()) {
      accessToken = await refreshAirtableToken(supabase, user.id, integration);
      if (!accessToken) {
        return new Response(JSON.stringify({ error: 'Airtable token expired. Please reconnect.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const baseId = integration.config?.base_id;
    const tableId = integration.config?.table_id || integration.config?.table_name || 'Leads';

    if (!baseId) {
      return new Response(JSON.stringify({ error: 'Airtable base ID not configured' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get leads from request
    const body = await request.json();
    const { leads } = body;

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return new Response(JSON.stringify({ error: 'No leads provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create records in Airtable (max 10 per request)
    const results = await createAirtableRecords(accessToken, baseId, tableId, leads);

    return new Response(JSON.stringify({
      success: true,
      count: results.successCount,
      failed: results.failedCount,
      errors: results.errors,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Airtable export error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

async function refreshAirtableToken(
  supabase: ReturnType<typeof import('@supabase/supabase-js').createClient>,
  userId: string,
  integration: any
): Promise<string | null> {
  try {
    const clientId = import.meta.env.AIRTABLE_CLIENT_ID;
    const clientSecret = import.meta.env.AIRTABLE_CLIENT_SECRET;

    if (!clientId || !integration.refresh_token) {
      return null;
    }

    const response = await fetch('https://airtable.com/oauth2/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Airtable requires Basic auth for token refresh
        'Authorization': `Basic ${btoa(`${clientId}:${clientSecret || ''}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: integration.refresh_token,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    // Update stored tokens
    await supabase
      .from('integrations')
      .update({
        access_token: data.access_token,
        refresh_token: data.refresh_token || integration.refresh_token,
        token_expires_at: new Date(Date.now() + (data.expires_in || 7200) * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('provider', 'airtable');

    return data.access_token;
  } catch {
    return null;
  }
}

async function createAirtableRecords(
  accessToken: string,
  baseId: string,
  tableId: string,
  leads: any[]
): Promise<{ successCount: number; failedCount: number; errors: string[] }> {
  const results = {
    successCount: 0,
    failedCount: 0,
    errors: [] as string[],
  };

  // Airtable allows max 10 records per request
  const batchSize = 10;

  for (let i = 0; i < leads.length; i += batchSize) {
    const batch = leads.slice(i, i + batchSize);

    const records = batch.map(lead => ({
      fields: {
        'Business Name': lead.name || lead.businessName || lead.business_name || '',
        'Owner Name': lead.ownerName || lead.owner_name || '',
        'Owner Title': lead.ownerTitle || lead.owner_title || '',
        'Email': lead.email || '',
        'Phone': lead.phone || '',
        'Website': lead.website || '',
        'Address': lead.address || lead.fullAddress || lead.full_address || '',
        'Rating': lead.rating ? parseFloat(lead.rating) : null,
        'Reviews': lead.reviewsCount || lead.reviews_count || null,
        'Source': 'PullLeads',
        'Imported At': new Date().toISOString(),
      }
    }));

    try {
      const response = await fetch(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableId)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        results.failedCount += batch.length;
        results.errors.push(errorData.error?.message || `HTTP ${response.status}`);

        // Handle rate limiting
        if (response.status === 429) {
          // Wait 30 seconds and retry
          await new Promise(resolve => setTimeout(resolve, 30000));
          i -= batchSize; // Retry this batch
        }
        continue;
      }

      const data = await response.json();
      results.successCount += data.records?.length || 0;

      // Respect rate limits (5 req/sec per base)
      await new Promise(resolve => setTimeout(resolve, 250));

    } catch (error: any) {
      results.failedCount += batch.length;
      results.errors.push(error.message);
    }
  }

  return results;
}
