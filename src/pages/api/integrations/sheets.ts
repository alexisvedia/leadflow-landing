import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.PUBLIC_SUPABASE_URL,
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY
);

// POST - Connect Google Sheets
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
    const { spreadsheetId } = body;

    if (!spreadsheetId) {
      return new Response(JSON.stringify({ error: 'Spreadsheet ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Validate spreadsheet ID format (basic check)
    if (!/^[a-zA-Z0-9_-]{20,50}$/.test(spreadsheetId)) {
      return new Response(JSON.stringify({ error: 'Invalid spreadsheet ID format' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Save integration
    const { error: upsertError } = await supabase
      .from('integrations')
      .upsert({
        user_id: user.id,
        provider: 'google_sheets',
        config: { spreadsheet_id: spreadsheetId },
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
    console.error('Sheets connect error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// DELETE - Disconnect Google Sheets
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
      .eq('provider', 'google_sheets');

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
    console.error('Sheets disconnect error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
