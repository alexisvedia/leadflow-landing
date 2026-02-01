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

    // Get Salesforce integration
    const { data: integration } = await supabase
      .from('integrations')
      .select('*')
      .eq('user_id', user.id)
      .eq('provider', 'salesforce')
      .eq('is_active', true)
      .single();

    if (!integration) {
      return new Response(JSON.stringify({ error: 'Salesforce not connected. Please connect it first.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check if token is expired and refresh if needed
    let accessToken = integration.access_token;
    if (integration.token_expires_at && new Date(integration.token_expires_at) < new Date()) {
      accessToken = await refreshSalesforceToken(supabase, user.id, integration);
      if (!accessToken) {
        return new Response(JSON.stringify({ error: 'Salesforce token expired. Please reconnect.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const instanceUrl = integration.config?.instance_url;
    if (!instanceUrl) {
      return new Response(JSON.stringify({ error: 'Salesforce instance URL not found' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get leads from request
    const body = await request.json();
    const { leads, objectType = 'Lead' } = body;

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return new Response(JSON.stringify({ error: 'No leads provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create leads/contacts in Salesforce using Composite API for batch operations
    const results = await createSalesforceRecords(instanceUrl, accessToken, leads, objectType);

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
    console.error('Salesforce export error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

async function refreshSalesforceToken(
  supabase: ReturnType<typeof import('@supabase/supabase-js').createClient>,
  userId: string,
  integration: any
): Promise<string | null> {
  try {
    const clientId = import.meta.env.SALESFORCE_CLIENT_ID;
    const clientSecret = import.meta.env.SALESFORCE_CLIENT_SECRET;

    if (!clientId || !clientSecret || !integration.refresh_token) {
      return null;
    }

    const response = await fetch('https://login.salesforce.com/services/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: integration.refresh_token,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    // Update stored token
    await supabase
      .from('integrations')
      .update({
        access_token: data.access_token,
        token_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('provider', 'salesforce');

    return data.access_token;
  } catch {
    return null;
  }
}

async function createSalesforceRecords(
  instanceUrl: string,
  accessToken: string,
  leads: any[],
  objectType: 'Lead' | 'Contact'
): Promise<{ successCount: number; failedCount: number; errors: string[] }> {
  const results = {
    successCount: 0,
    failedCount: 0,
    errors: [] as string[],
  };

  // Salesforce Composite API allows 25 records per request
  const batchSize = 25;

  for (let i = 0; i < leads.length; i += batchSize) {
    const batch = leads.slice(i, i + batchSize);

    const compositeRequest = {
      compositeRequest: batch.map((lead, index) => {
        const record: any = {
          Company: lead.name || lead.businessName || lead.business_name || 'Unknown',
          Email: lead.email || null,
          Phone: lead.phone || null,
          Website: lead.website || null,
          Street: lead.address || lead.fullAddress || lead.full_address || null,
        };

        // Split owner name into first/last
        const ownerName = lead.ownerName || lead.owner_name || '';
        const nameParts = ownerName.split(' ');
        record.FirstName = nameParts[0] || '';
        record.LastName = nameParts.slice(1).join(' ') || (objectType === 'Lead' ? 'Unknown' : '');

        if (objectType === 'Lead') {
          record.Title = lead.ownerTitle || lead.owner_title || null;
          record.Status = 'Open - Not Contacted';
        }

        return {
          method: 'POST',
          url: `/services/data/v59.0/sobjects/${objectType}`,
          referenceId: `record_${i + index}`,
          body: record,
        };
      }),
    };

    try {
      const response = await fetch(`${instanceUrl}/services/data/v59.0/composite`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(compositeRequest),
      });

      if (!response.ok) {
        const errorText = await response.text();
        results.failedCount += batch.length;
        results.errors.push(`Batch failed: ${errorText}`);
        continue;
      }

      const data = await response.json();

      for (const result of data.compositeResponse) {
        if (result.httpStatusCode >= 200 && result.httpStatusCode < 300) {
          results.successCount++;
        } else {
          results.failedCount++;
          if (result.body?.length > 0) {
            results.errors.push(result.body[0]?.message || 'Unknown error');
          }
        }
      }
    } catch (error: any) {
      results.failedCount += batch.length;
      results.errors.push(error.message);
    }
  }

  return results;
}
