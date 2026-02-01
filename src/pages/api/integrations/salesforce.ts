import type { APIRoute } from 'astro';
import { getSupabaseServer } from '../../../lib/supabase-server';

// GET - Initiate OAuth flow (redirect to Salesforce)
export const GET: APIRoute = async ({ request, redirect }) => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // If we have a code, this is the OAuth callback
  if (code) {
    return handleOAuthCallback(request, code, state);
  }

  // Otherwise, start the OAuth flow
  const clientId = import.meta.env.SALESFORCE_CLIENT_ID;
  const redirectUri = `${url.origin}/api/integrations/salesforce`;

  if (!clientId) {
    return new Response(JSON.stringify({ error: 'Salesforce not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Generate state token for CSRF protection
  const stateToken = crypto.randomUUID();

  const authUrl = new URL('https://login.salesforce.com/services/oauth2/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'api refresh_token');
  authUrl.searchParams.set('state', stateToken);

  return redirect(authUrl.toString());
};

async function handleOAuthCallback(request: Request, code: string, state: string | null) {
  const supabase = getSupabaseServer();

  if (!supabase) {
    return new Response(JSON.stringify({ error: 'Service not configured' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const clientId = import.meta.env.SALESFORCE_CLIENT_ID;
  const clientSecret = import.meta.env.SALESFORCE_CLIENT_SECRET;
  const redirectUri = `${url.origin}/api/integrations/salesforce`;

  if (!clientId || !clientSecret) {
    return Response.redirect(`${url.origin}/dashboard/integrations?error=salesforce_not_configured`);
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await fetch('https://login.salesforce.com/services/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Salesforce token error:', errorText);
      return Response.redirect(`${url.origin}/dashboard/integrations?error=salesforce_auth_failed`);
    }

    const tokens = await tokenResponse.json();

    // Get user info from cookie/header
    const authHeader = request.headers.get('cookie');
    let userId: string | null = null;

    // Try to get user from Supabase session
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      userId = session.user.id;
    }

    if (!userId) {
      // Fallback: Try to decode state which might contain user ID
      // In production, you'd want a more secure state management
      return Response.redirect(`${url.origin}/auth/login?redirect=/dashboard/integrations`);
    }

    // Save integration
    await supabase
      .from('integrations')
      .upsert({
        user_id: userId,
        provider: 'salesforce',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours
        config: {
          instance_url: tokens.instance_url,
          id: tokens.id,
        },
        is_active: true,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,provider',
      });

    return Response.redirect(`${url.origin}/dashboard/integrations?success=salesforce`);

  } catch (error: any) {
    console.error('Salesforce OAuth error:', error);
    return Response.redirect(`${url.origin}/dashboard/integrations?error=salesforce_error`);
  }
}

// POST - Connect with access token (manual method)
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
    const { accessToken, instanceUrl, refreshToken } = body;

    if (!accessToken || !instanceUrl) {
      return new Response(JSON.stringify({ error: 'Access token and instance URL required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate the token by making a test request
    const testResponse = await fetch(`${instanceUrl}/services/data/v59.0/sobjects/Lead/describe`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!testResponse.ok) {
      return new Response(JSON.stringify({ error: 'Invalid Salesforce credentials' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Save integration
    const { error: upsertError } = await supabase
      .from('integrations')
      .upsert({
        user_id: user.id,
        provider: 'salesforce',
        access_token: accessToken,
        refresh_token: refreshToken || null,
        config: {
          instance_url: instanceUrl,
        },
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
    console.error('Salesforce connect error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// DELETE - Disconnect Salesforce
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
      .eq('provider', 'salesforce');

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
    console.error('Salesforce disconnect error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
