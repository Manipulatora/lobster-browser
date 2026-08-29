import { ForbiddenException } from '@nestjs/common';

import type { TeamsRepository } from './teams.repository';

/**
 * Resolve which team a request acts on, enforcing membership.
 *
 * The rule, in one place: an EXPLICIT teamId is honoured only after proving the caller is a member
 * of it (the check that stands between this API and cross-team IDOR); an OMITTED teamId falls back
 * to the caller's first team, which for today's accounts is the personal team registration
 * created.
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
  const memberships = await teams.findTeamsForUser(userId);
  const first = memberships[0];
  if (!first) {
    throw new ForbiddenException('you do not belong to any team');
  }
  return first.id;
}
