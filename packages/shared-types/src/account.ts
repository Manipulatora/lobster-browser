export type Role = 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  displayName?: string;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
}

export interface Membership {
  userId: string;
  teamId: string;
  role: Role;
  createdAt: string;
}

/** API key for the local automation API / backend programmatic access. */
export interface ApiKey {
  id: string;
  /** Only the prefix is stored/displayed after creation; the secret is shown once. */
  prefix: string;
  name: string;
  teamId: string;
  createdAt: string;
  lastUsedAt?: string;
}

export type PlanTier = 'free' | 'pro' | 'team' | 'enterprise';

export interface Subscription {
  teamId: string;
  tier: PlanTier;
  /** Metered limit — number of profiles allowed on this plan. */
  profileLimit: number;
  stripeCustomerId?: string;
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
}
