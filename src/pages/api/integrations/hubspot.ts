import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.PUBLIC_SUPABASE_URL,
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY
);

// POST - Connect HubSpot
export const POST: APIRoute = async ({ request }) => {
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
    const { accessToken } = body;

    if (!accessToken) {
      return new Response(JSON.stringify({ error: 'Access token required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate HubSpot token by making a test request
    const testResponse = await fetch('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!testResponse.ok) {
      return new Response(JSON.stringify({ error: 'Invalid HubSpot access token' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Save integration
    const { error: upsertError } = await supabase
      .from('integrations')
      .upsert({
        user_id: user.id,
        provider: 'hubspot',
        access_token: accessToken,
        is_active: true,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,provider',
      });

    if (upsertError) {
      return new Response(JSON.stringify({ error: 'Failed to save integration' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('HubSpot connect error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// DELETE - Disconnect HubSpot
export const DELETE: APIRoute = async ({ request }) => {
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

    const { error: deleteError } = await supabase
      .from('integrations')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', 'hubspot');

    if (deleteError) {
      return new Response(JSON.stringify({ error: 'Failed to disconnect' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('HubSpot disconnect error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
