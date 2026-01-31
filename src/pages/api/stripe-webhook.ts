import type { APIRoute } from 'astro';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-11-20.acacia',
});

const supabase = createClient(
  import.meta.env.PUBLIC_SUPABASE_URL,
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY
);

const WEBHOOK_SECRET = import.meta.env.STRIPE_WEBHOOK_SECRET;

// Credits per plan
const PLAN_CREDITS: Record<string, number> = {
  starter: 1000,
  growth: 5000,
  scale: 20000,
};

// Map price IDs to plans
function getPlanFromPriceId(priceId: string): string {
  const priceMap: Record<string, string> = {
    [import.meta.env.STRIPE_PRICE_STARTER || 'price_starter']: 'starter',
    [import.meta.env.STRIPE_PRICE_GROWTH || 'price_growth']: 'growth',
    [import.meta.env.STRIPE_PRICE_SCALE || 'price_scale']: 'scale',
  };
  return priceMap[priceId] || 'free';
}

export const POST: APIRoute = async ({ request }) => {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig) {
    return new Response('No signature', { status: 400 });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(body, sig, WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        const plan = session.metadata?.plan || 'starter';

        if (userId && session.subscription) {
          // Update profile with new plan
          await supabase
            .from('profiles')
            .update({
              plan,
              stripe_customer_id: session.customer as string,
            })
            .eq('id', userId);

          // Update or create subscription
          const credits = PLAN_CREDITS[plan] || 1000;
          const now = new Date();
          const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

          await supabase
            .from('subscriptions')
            .upsert({
              user_id: userId,
              stripe_subscription_id: session.subscription as string,
              credits_remaining: credits,
              credits_total: credits,
              period_start: now.toISOString(),
              period_end: endDate.toISOString(),
            }, {
              onConflict: 'user_id',
            });
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as Stripe.Invoice;

        // Only process subscription renewals, not the first payment
        if (invoice.billing_reason === 'subscription_cycle') {
          const subscriptionId = invoice.subscription as string;

          // Get subscription details
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const priceId = subscription.items.data[0]?.price?.id;
          const plan = getPlanFromPriceId(priceId || '');
          const userId = subscription.metadata?.userId;

          if (userId) {
            // Reset credits for new billing period
            const credits = PLAN_CREDITS[plan] || 1000;
            const now = new Date();
            const endDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

            await supabase
              .from('subscriptions')
              .update({
                credits_remaining: credits,
                credits_total: credits,
                period_start: now.toISOString(),
                period_end: endDate.toISOString(),
              })
              .eq('user_id', userId);
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId;
        const priceId = subscription.items.data[0]?.price?.id;
        const plan = getPlanFromPriceId(priceId || '');

        if (userId) {
          // Update plan in profile
          await supabase
            .from('profiles')
            .update({ plan })
            .eq('id', userId);

          // If upgraded, add additional credits
          const newCredits = PLAN_CREDITS[plan] || 1000;

          const { data: currentSub } = await supabase
            .from('subscriptions')
            .select('credits_remaining, credits_total')
            .eq('user_id', userId)
            .single();

          if (currentSub && newCredits > currentSub.credits_total) {
            // User upgraded - add the difference
            const additionalCredits = newCredits - currentSub.credits_total;
            await supabase
              .from('subscriptions')
              .update({
                credits_remaining: currentSub.credits_remaining + additionalCredits,
                credits_total: newCredits,
              })
              .eq('user_id', userId);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId;

        if (userId) {
          // Downgrade to free plan
          await supabase
            .from('profiles')
            .update({ plan: 'free' })
            .eq('id', userId);

          // Keep remaining credits until they expire
          // Optionally set credits to 0 or free tier amount
        }
        break;
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error: any) {
    console.error('Webhook processing error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
