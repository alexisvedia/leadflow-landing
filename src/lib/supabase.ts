import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Types for our database
export interface Profile {
  id: string;
  email: string;
  stripe_customer_id: string | null;
  plan: 'free' | 'starter' | 'growth' | 'scale';
  created_at: string;
}

export interface Subscription {
  id: string;
  user_id: string;
  stripe_subscription_id: string | null;
  credits_remaining: number;
  credits_total: number;
  period_start: string;
  period_end: string;
}

export interface Extraction {
  id: string;
  user_id: string;
  query: string;
  location: string;
  source: string;
  leads_count: number | null;
  credits_used: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  apify_run_id: string | null;
  result_data: any | null;
  webhook_url: string | null;
  created_at: string;
}

// Plan configurations
export const PLANS = {
  free: { credits: 50, price: 0 },
  starter: { credits: 1000, price: 49 },
  growth: { credits: 5000, price: 99 },
  scale: { credits: 20000, price: 249 },
} as const;

// Helper to get user's subscription
export async function getUserSubscription(userId: string): Promise<Subscription | null> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) {
    console.error('Error fetching subscription:', error);
    return null;
  }

  return data;
}

// Helper to get user's profile
export async function getUserProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  if (error) {
    console.error('Error fetching profile:', error);
    return null;
  }

  return data;
}

// Helper to get user's extractions
export async function getUserExtractions(userId: string): Promise<Extraction[]> {
  const { data, error } = await supabase
    .from('extractions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching extractions:', error);
    return [];
  }

  return data || [];
}
