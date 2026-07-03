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

/**
 * An immutable action/audit-log entry. Written by the backend whenever a meaningful action
 * happens (profile created, member invited, subscription changed, …) so a team has a durable,
 * append-only history. Rows are never updated or deleted in the ordinary flow — they are the
 * record of what happened. Every entry is scoped to exactly one team.
 */
export interface AuditLog {
  id: string;
  teamId: string;
  /** The user who performed the action; absent for system-originated events. */
  actorUserId?: string;
  /** Machine-readable action name, e.g. `profile.created` / `member.invited`. */
  action: string;
  /** The kind of thing the action targeted, e.g. `profile` / `membership`. */
  targetType: string;
  /** Id of the specific target, when the action concerns one. */
  targetId?: string;
  /** Free-form, non-secret context for the event (opaque JSON grab-bag). */
  metadata?: Record<string, unknown>;
  createdAt: string;
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
