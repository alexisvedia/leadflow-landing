import type { APIRoute } from 'astro';
import { getSupabaseServer } from '../../../lib/supabase-server';

interface Lead {
  name: string;
  email: string;
  phone?: string;
  website?: string;
  address?: string;
  category?: string;
}

// Split name into first and last
function splitName(fullName: string): { firstname: string; lastname: string } {
  const parts = fullName.trim().split(' ');
  if (parts.length === 1) {
    return { firstname: parts[0], lastname: '' };
  }
  return {
    firstname: parts[0],
    lastname: parts.slice(1).join(' '),
  };
}

// POST - Export leads to HubSpot
export const POST: APIRoute = async ({ request }) => {
  const supabase = getSupabaseServer();

  if (!supabase) {
    return new Response(JSON.stringify({ error: 'Service not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
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

    const body = await request.json();
    const { extractionId, leads } = body;

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return new Response(JSON.stringify({ error: 'No leads provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get HubSpot integration
    const { data: integration, error: intError } = await supabase
      .from('integrations')
      .select('access_token')
      .eq('user_id', user.id)
      .eq('provider', 'hubspot')
      .eq('is_active', true)
      .single();

    if (intError || !integration) {
      return new Response(JSON.stringify({ error: 'HubSpot not connected' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const hubspotToken = integration.access_token;

    // Prepare contacts for batch create (max 100 per batch)
    const batchSize = 100;
    const results = {
      created: 0,
      errors: [] as string[],
    };

    for (let i = 0; i < leads.length; i += batchSize) {
      const batch = leads.slice(i, i + batchSize);

      const inputs = batch
        .filter((lead: Lead) => lead.email) // Must have email
        .map((lead: Lead) => {
          const { firstname, lastname } = splitName(lead.name || '');

          return {
            properties: {
              email: lead.email,
              firstname,
              lastname,
              phone: lead.phone || '',
              website: lead.website || '',
              address: lead.address || '',
              jobtitle: lead.category || '',
              lifecyclestage: 'lead',
            },
          };
        });

      if (inputs.length === 0) continue;

      try {
        const response = await fetch(
          'https://api.hubapi.com/crm/v3/objects/contacts/batch/create',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${hubspotToken}`,
            },
            body: JSON.stringify({ inputs }),
          }
        );

        const result = await response.json();

        if (response.ok) {
          results.created += result.results?.length || 0;
        } else {
          // Handle partial failures
          if (result.errors) {
            result.errors.forEach((err: any) => {
              results.errors.push(err.message || 'Unknown error');
            });
          }

          // Some may have succeeded
          if (result.results) {
            results.created += result.results.length;
          }
        }
      } catch (batchError: any) {
        results.errors.push(`Batch ${Math.floor(i / batchSize) + 1} failed: ${batchError.message}`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      created: results.created,
      errors: results.errors,
      total: leads.length,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('HubSpot export error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
