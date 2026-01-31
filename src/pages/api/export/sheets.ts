import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.PUBLIC_SUPABASE_URL,
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY
);

// Google service account credentials (from env)
const GOOGLE_SERVICE_ACCOUNT = import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(import.meta.env.GOOGLE_SERVICE_ACCOUNT_JSON)
  : null;

interface Lead {
  name: string;
  email: string;
  phone?: string;
  website?: string;
  address?: string;
  category?: string;
  rating?: string;
  reviews_count?: string;
  source?: string;
}

// Get Google access token using service account
async function getGoogleAccessToken(): Promise<string | null> {
  if (!GOOGLE_SERVICE_ACCOUNT) {
    console.error('Google service account not configured');
    return null;
  }

  try {
    // Create JWT
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iss: GOOGLE_SERVICE_ACCOUNT.client_email,
      scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    // Encode JWT (simplified - in production use a proper JWT library)
    const base64Header = btoa(JSON.stringify(header));
    const base64Payload = btoa(JSON.stringify(payload));

    // Sign with private key
    const encoder = new TextEncoder();
    const data = encoder.encode(`${base64Header}.${base64Payload}`);

    // Import private key
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(GOOGLE_SERVICE_ACCOUNT.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, data);
    const base64Signature = btoa(String.fromCharCode(...new Uint8Array(signature)));

    const jwt = `${base64Header}.${base64Payload}.${base64Signature}`;

    // Exchange JWT for access token
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    const result = await response.json();
    return result.access_token || null;

  } catch (error) {
    console.error('Failed to get Google access token:', error);
    return null;
  }
}

// Convert PEM to ArrayBuffer
function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\n/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// POST - Export leads to Google Sheets
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
    const { extractionId, leads, sheetName } = body;

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return new Response(JSON.stringify({ error: 'No leads provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get Google Sheets integration
    const { data: integration, error: intError } = await supabase
      .from('integrations')
      .select('config')
      .eq('user_id', user.id)
      .eq('provider', 'google_sheets')
      .eq('is_active', true)
      .single();

    if (intError || !integration) {
      return new Response(JSON.stringify({ error: 'Google Sheets not connected' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const spreadsheetId = integration.config?.spreadsheet_id;
    if (!spreadsheetId) {
      return new Response(JSON.stringify({ error: 'Spreadsheet ID not configured' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get Google access token
    const googleToken = await getGoogleAccessToken();
    if (!googleToken) {
      return new Response(JSON.stringify({ error: 'Failed to authenticate with Google' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Prepare rows
    const headers = ['Name', 'Email', 'Phone', 'Website', 'Address', 'Category', 'Rating', 'Reviews', 'Source'];
    const rows = leads.map((lead: Lead) => [
      lead.name || '',
      lead.email || '',
      lead.phone || '',
      lead.website || '',
      lead.address || '',
      lead.category || '',
      lead.rating || '',
      lead.reviews_count || '',
      lead.source || '',
    ]);

    // Add header row if sheet is empty (first export)
    const allRows = [headers, ...rows];

    // Append to sheet
    const range = sheetName ? `${sheetName}!A1` : 'Sheet1!A1';

    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${googleToken}`,
        },
        body: JSON.stringify({
          values: allRows,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      console.error('Sheets API error:', error);
      return new Response(JSON.stringify({
        error: error.error?.message || 'Failed to append to sheet'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await response.json();

    return new Response(JSON.stringify({
      success: true,
      rowsAdded: leads.length,
      updatedRange: result.updates?.updatedRange,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Sheets export error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
