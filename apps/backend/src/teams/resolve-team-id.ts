import { ForbiddenException } from '@nestjs/common';
import type { Team } from '@lobster/shared-types';

import type { TeamsRepository } from './teams.repository';

/**
 * Resolve which team a request acts on, enforcing membership.
 *
 * The rule, in one place: an EXPLICIT teamId is honoured only after proving the caller is a member
 * of it (the check that stands between this API and cross-team IDOR); an OMITTED teamId means the
 * caller's OWN team — the personal team registration created, or the oldest team they own.
 *
 * It used to mean "the oldest team the caller belongs to", which is a different thing the moment
 * somebody else is involved. Ivy created her team in July and invites Bob, whose personal team
 * dates from August. The desktop sends no teamId on any call, so Bob's next reconcile listed Ivy's
 * profiles, pushed his own dirty profiles into her blob namespace, and his agent token was minted
 * against her wallet — while his own profiles vanished from his list. Accepting an invitation had
 * silently moved his sync, his billing and his agent spend. Ownership is the one thing nobody
 * else's action can change, which is what makes it the only stable default; a team someone was
 * invited into stays reachable exactly as before, by naming it.
 *
 * This function existed five times — agent token, api-keys, audit, billing, profiles — as
 * copy-pasted private methods, identical to the byte modulo brace style. Five copies of an
 * authorization rule is five places a future change (say, roles that may not act for the team)
 * can miss one. A free function rather than a service so callers keep their existing
 * TEAMS_REPOSITORY injection and nothing changes in any module graph.
 */
export async function resolveTeamId(
  teams: TeamsRepository,
  userId: string,
  requestedTeamId?: string,
): Promise<string> {
  if (requestedTeamId) {
    const membership = await teams.getMembership(requestedTeamId, userId);
    if (!membership) {
      throw new ForbiddenException('you are not a member of the requested team');
    }
    return requestedTeamId;
  }
  const home = defaultTeamOf(userId, await teams.findTeamsForUser(userId));
  if (!home) {
    throw new ForbiddenException('you do not belong to any team');
  }
  return home.id;
}

/**
 * The team a caller acts on when they name none: the oldest team they OWN, which for every
 * registered account is the personal team created at sign-up.
 *
 * Falls back to the oldest membership only for an account that owns nothing at all. No code path
 * produces such an account today (registration always creates the personal team; there is no team
 * deletion and no ownership transfer), but refusing every teamId-less call would brick the desktop
 * for it — and for an account with no team of its own, an invited team is not a redirection away
 * from anything.
 */
export function defaultTeamOf(userId: string, teams: readonly Team[]): Team | undefined {
  const oldestFirst = [...teams].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return oldestFirst.find((team) => team.ownerUserId === userId) ?? oldestFirst[0];
}
