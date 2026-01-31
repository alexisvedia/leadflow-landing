-- PullLeads Database Schema
-- Run this in Supabase SQL Editor

-- ============================================
-- 1. PROFILES TABLE
-- Extends auth.users with app-specific data
-- ============================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  email TEXT,
  stripe_customer_id TEXT,
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'growth', 'scale')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- ============================================
-- 2. SUBSCRIPTIONS TABLE
-- Tracks credits and billing period
-- ============================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL UNIQUE,
  stripe_subscription_id TEXT,
  credits_remaining INTEGER DEFAULT 50,
  credits_total INTEGER DEFAULT 50,
  period_start TIMESTAMPTZ DEFAULT NOW(),
  period_end TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own subscription"
  ON public.subscriptions FOR SELECT
  USING (auth.uid() = user_id);

-- Only service role can update subscriptions (via webhooks)
CREATE POLICY "Service role can manage subscriptions"
  ON public.subscriptions FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================
-- 3. EXTRACTIONS TABLE
-- Tracks lead extraction jobs
-- ============================================
CREATE TABLE IF NOT EXISTS public.extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  query TEXT NOT NULL,
  location TEXT NOT NULL,
  source TEXT DEFAULT 'google_maps',
  leads_count INTEGER,
  credits_used INTEGER NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  apify_run_id TEXT,
  result_data JSONB,
  webhook_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- Enable RLS
ALTER TABLE public.extractions ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view own extractions"
  ON public.extractions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own extractions"
  ON public.extractions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role can manage extractions"
  ON public.extractions FOR ALL
  USING (auth.role() = 'service_role');

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_extractions_user_id ON public.extractions(user_id);
CREATE INDEX IF NOT EXISTS idx_extractions_status ON public.extractions(status);

-- ============================================
-- 4. INTEGRATIONS TABLE
-- Stores user's connected integrations
-- ============================================
CREATE TABLE IF NOT EXISTS public.integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('hubspot', 'google_sheets', 'webhook')),
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  config JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider)
);

-- Enable RLS
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can manage own integrations"
  ON public.integrations FOR ALL
  USING (auth.uid() = user_id);

-- ============================================
-- 5. TRIGGER: Auto-create profile on signup
-- ============================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- Create profile
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);

  -- Create subscription with free tier credits
  INSERT INTO public.subscriptions (user_id, credits_remaining, credits_total)
  VALUES (NEW.id, 50, 50);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop trigger if exists and recreate
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ============================================
-- 6. FUNCTION: Deduct credits
-- ============================================
CREATE OR REPLACE FUNCTION public.deduct_credits(
  p_user_id UUID,
  p_amount INTEGER
)
RETURNS BOOLEAN AS $$
DECLARE
  v_remaining INTEGER;
BEGIN
  -- Get current credits
  SELECT credits_remaining INTO v_remaining
  FROM public.subscriptions
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- Check if enough credits
  IF v_remaining IS NULL OR v_remaining < p_amount THEN
    RETURN FALSE;
  END IF;

  -- Deduct credits
  UPDATE public.subscriptions
  SET credits_remaining = credits_remaining - p_amount,
      updated_at = NOW()
  WHERE user_id = p_user_id;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 7. FUNCTION: Refund credits
-- ============================================
CREATE OR REPLACE FUNCTION public.refund_credits(
  p_user_id UUID,
  p_amount INTEGER
)
RETURNS VOID AS $$
BEGIN
  UPDATE public.subscriptions
  SET credits_remaining = LEAST(credits_remaining + p_amount, credits_total),
      updated_at = NOW()
  WHERE user_id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- DONE!
-- ============================================
-- After running this script:
-- 1. Go to Authentication > Settings in Supabase Dashboard
-- 2. Enable Email auth with magic links
-- 3. (Optional) Enable Google OAuth
-- 4. Set Site URL to your production domain
-- 5. Add redirect URLs for auth callbacks
