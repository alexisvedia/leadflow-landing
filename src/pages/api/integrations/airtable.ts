import type { APIRoute } from 'astro';
import { getSupabaseServer } from '../../../lib/supabase-server';

// Helper to generate PKCE code verifier and challenge
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64urlEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return base64urlEncode(new Uint8Array(hash));
}

function base64urlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buffer.byteLength; i++) {
    binary += String.fromCharCode(buffer[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Simple in-memory store for PKCE verifiers (in production, use Redis/DB)
const pkceStore = new Map<string, { verifier: string; userId?: string; expires: number }>();

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pkceStore.entries()) {
    if (value.expires < now) {
      pkceStore.delete(key);
    }
  }
}, 60000);

// GET - Initiate OAuth flow or handle callback
export const GET: APIRoute = async ({ request, redirect }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // If we have a code, this is the OAuth callback
  if (code && state) {
    return handleOAuthCallback(request, code, state);
  }

  // Otherwise, start the OAuth flow
  const clientId = import.meta.env.AIRTABLE_CLIENT_ID;
  const redirectUri = `${url.origin}/api/integrations/airtable`;

  if (!clientId) {
    return new Response(JSON.stringify({ error: 'Airtable not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Generate PKCE values
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const stateToken = crypto.randomUUID();

  // Store verifier for later use in callback
  pkceStore.set(stateToken, {
    verifier: codeVerifier,
    expires: Date.now() + 10 * 60 * 1000, // 10 minutes
  });

  const authUrl = new URL('https://airtable.com/oauth2/v1/authorize');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'data.records:read data.records:write schema.bases:read');
  authUrl.searchParams.set('state', stateToken);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  return redirect(authUrl.toString());
};

async function handleOAuthCallback(request: Request, code: string, state: string) {
  const supabase = getSupabaseServer();

  if (!supabase) {
    return new Response(JSON.stringify({ error: 'Service not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const clientId = import.meta.env.AIRTABLE_CLIENT_ID;
  const clientSecret = import.meta.env.AIRTABLE_CLIENT_SECRET;
  const redirectUri = `${url.origin}/api/integrations/airtable`;

  // Retrieve PKCE verifier
  const pkceData = pkceStore.get(state);
  if (!pkceData) {
    return Response.redirect(`${url.origin}/dashboard/integrations?error=airtable_invalid_state`);
  }
  pkceStore.delete(state);

  if (!clientId) {
    return Response.redirect(`${url.origin}/dashboard/integrations?error=airtable_not_configured`);
  }

  try {
    // Exchange code for tokens
    const tokenBody: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: pkceData.verifier,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    // If we have a client secret, use Basic auth
    if (clientSecret) {
      headers['Authorization'] = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
    }

    const tokenResponse = await fetch('https://airtable.com/oauth2/v1/token', {
      method: 'POST',
      headers,
      body: new URLSearchParams(tokenBody),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Airtable token error:', errorText);
      return Response.redirect(`${url.origin}/dashboard/integrations?error=airtable_auth_failed`);
    }

    const tokens = await tokenResponse.json();

    // Get user from session
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      return Response.redirect(`${url.origin}/auth/login?redirect=/dashboard/integrations`);
    }

    // Get user's bases to let them choose which one to use
    const basesResponse = await fetch('https://api.airtable.com/v0/meta/bases', {
      headers: {
        'Authorization': `Bearer ${tokens.access_token}`,
      },
    });

    let bases: any[] = [];
    if (basesResponse.ok) {
      const basesData = await basesResponse.json();
      bases = basesData.bases || [];
    }

    // Save integration with first base as default (user can change later)
    await supabase
      .from('integrations')
      .upsert({
        user_id: session.user.id,
        provider: 'airtable',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: new Date(Date.now() + (tokens.expires_in || 7200) * 1000).toISOString(),
        config: {
          base_id: bases[0]?.id || null,
          bases: bases.map(b => ({ id: b.id, name: b.name })),
        },
        is_active: true,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,provider',
      });

    return Response.redirect(`${url.origin}/dashboard/integrations?success=airtable`);

  } catch (error: any) {
    console.error('Airtable OAuth error:', error);
    return Response.redirect(`${url.origin}/dashboard/integrations?error=airtable_error`);
  }
}

// POST - Update config (select base/table)
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
    const { baseId, tableId } = body;

    if (!baseId) {
      return new Response(JSON.stringify({ error: 'Base ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get existing integration
    const { data: integration } = await supabase
      .from('integrations')
      .select('*')
      .eq('user_id', user.id)
      .eq('provider', 'airtable')
      .single();

    if (!integration) {
      return new Response(JSON.stringify({ error: 'Airtable not connected' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update config
    const { error: updateError } = await supabase
      .from('integrations')
      .update({
        config: {
          ...integration.config,
          base_id: baseId,
          table_id: tableId || 'Leads',
        },
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', user.id)
      .eq('provider', 'airtable');

    if (updateError) {
      return new Response(JSON.stringify({ error: 'Failed to update config' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Airtable config update error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// DELETE - Disconnect Airtable
export const DELETE: APIRoute = async ({ request }) => {
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

    const { error: deleteError } = await supabase
      .from('integrations')
      .delete()
      .eq('user_id', user.id)
      .eq('provider', 'airtable');

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
    console.error('Airtable disconnect error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
