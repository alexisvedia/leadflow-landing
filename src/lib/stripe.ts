import Stripe from 'stripe';

// Lazy initialization for server-side Stripe client
let stripe: Stripe | null = null;

export function getStripe(): Stripe | null {
  if (!stripe && import.meta.env.STRIPE_SECRET_KEY) {
    stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-11-20.acacia',
    });
  }
  return stripe;
}

// Export for backwards compatibility - will be null during build
export { stripe };

// Price IDs - Replace with your actual Stripe price IDs
export const STRIPE_PRICES = {
  starter: import.meta.env.STRIPE_PRICE_STARTER || 'price_starter_monthly',
  growth: import.meta.env.STRIPE_PRICE_GROWTH || 'price_growth_monthly',
  scale: import.meta.env.STRIPE_PRICE_SCALE || 'price_scale_monthly',
} as const;

// Credits per plan
export const PLAN_CREDITS = {
  free: 50,
  starter: 1000,
  growth: 5000,
  scale: 20000,
} as const;

export type PlanType = keyof typeof PLAN_CREDITS;

// Map price IDs to plans
export function getPlanFromPriceId(priceId: string): PlanType {
  if (priceId === STRIPE_PRICES.starter) return 'starter';
  if (priceId === STRIPE_PRICES.growth) return 'growth';
  if (priceId === STRIPE_PRICES.scale) return 'scale';
  return 'free';
}

// Create checkout session
export async function createCheckoutSession(params: {
  priceId: string;
  userId: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}) {
  const stripeClient = getStripe();
  if (!stripeClient) {
    throw new Error('Stripe not configured');
  }

  const session = await stripeClient.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price: params.priceId,
        quantity: 1,
      },
    ],
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer_email: params.customerEmail,
    metadata: {
      userId: params.userId,
    },
    subscription_data: {
      metadata: {
        userId: params.userId,
      },
    },
  });

  return session;
}

// Create customer portal session
export async function createPortalSession(customerId: string, returnUrl: string) {
  const stripeClient = getStripe();
  if (!stripeClient) {
    throw new Error('Stripe not configured');
  }

  const session = await stripeClient.billingPortal.sessions.create({
    customer: customerId,
    return_url: returnUrl,
  });

  return session;
}
