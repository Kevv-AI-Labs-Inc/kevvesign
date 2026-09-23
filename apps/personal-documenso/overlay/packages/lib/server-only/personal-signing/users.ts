import { prisma } from '@documenso/prisma';

import { AppError, AppErrorCode } from '../../errors/app-error';
import { INTERNAL_CLAIM_ID, internalClaims } from '../../types/subscription';
import { createOrganisation } from '../organisation/create-organisation';
import { createTeam } from '../team/create-team';
import {
  assertPersonalHost,
  fetchPortalGrant,
  PersonalAccessError,
  type GoogleIdentity,
} from './access';

const denied = () =>
  new AppError(AppErrorCode.FORBIDDEN, {
    message: 'PERSONAL_SIGNING_ACCESS_DENIED',
    statusCode: 403,
  });

/** Only the verified Google callback may authorize a new browser session. */
export async function assertPersonalLoginMethod(_userId: number, googleVerified = false) {
  assertPersonalHost();
  if (!googleVerified) throw denied();
}

async function portalGrant(identity: GoogleIdentity) {
  try {
    return await fetchPortalGrant(identity);
  } catch (error) {
    if (error instanceof PersonalAccessError && error.status === 403) throw denied();
    throw new AppError(AppErrorCode.UNKNOWN_ERROR, {
      message: 'PERSONAL_SIGNING_UNAVAILABLE',
      statusCode: 503,
    });
  }
}

/** Used for new sessions, EVERY existing session check, and native API tokens. */
export async function assertPersonalUserAccess(userId: number) {
  assertPersonalHost();
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.disabled || !user.emailVerified) {
    await prisma.session.deleteMany({ where: { userId } });
    throw denied();
  }
  const mapping = await prisma.portalSigningIdentity.findUnique({ where: { userId } });
  try {
    if (!mapping || user.roles.includes('ADMIN') || user.email.toLowerCase() !== mapping.email)
      throw denied();
    const account = await prisma.account.findFirst({
      where: { userId, provider: 'google', providerAccountId: mapping.googleSubject },
    });
    if (!account) throw denied();
    const grant = await portalGrant(mapping);
    if (grant.agentId !== mapping.portalAgentId || grant.grantId !== mapping.grantId)
      throw denied();
    const workspace = await prisma.organisation.findUnique({
      where: { url: `homix-personal-${mapping.portalAgentId}` },
    });
    if (!workspace || workspace.ownerUserId !== userId || workspace.type !== 'PERSONAL')
      throw denied();
    // A manually added membership must not broaden a Portal-managed account's
    // access to another person's, legacy personal or HR workspace.
    const foreignMemberships = await prisma.organisationMember.count({
      where: { userId, organisationId: { not: workspace.id } },
    });
    const otherMembers = await prisma.organisationMember.count({
      where: { organisationId: workspace.id, userId: { not: userId } },
    });
    if (foreignMemberships || otherMembers) throw denied();
  } catch (error) {
    // An unavailable Portal denies the request, but does not destroy sessions.
    // A definitive revocation invalidates all browser sessions immediately.
    if (error instanceof AppError && error.statusCode === 403) {
      await prisma.session.deleteMany({ where: { userId } });
    }
    throw error;
  }
}

/** Called only AFTER upstream Google code+state+PKCE+verified-email validation. */
export async function provisionPersonalGoogleUser(identity: GoogleIdentity) {
  const grant = await portalGrant(identity);
  const user = await prisma.$transaction(async (tx) => {
    // Serialize first login and identity rotation for one immutable Portal user.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(702623, ${grant.agentId}::integer)`;
    const mapping = await tx.portalSigningIdentity.findUnique({
      where: { portalAgentId: grant.agentId },
    });
    const account = await tx.account.findFirst({
      where: { provider: 'google', providerAccountId: identity.googleSubject },
    });
    if (account && account.userId !== mapping?.userId) throw denied();
    const sameEmail = await tx.user.findFirst({
      where: { email: { equals: grant.email, mode: 'insensitive' } },
    });
    // Never adopt an old personal account based on email equality alone.
    if (sameEmail && sameEmail.id !== mapping?.userId) throw denied();
    const existingUser = mapping
      ? await tx.user.findUnique({ where: { id: mapping.userId } })
      : null;
    if (mapping && (!existingUser || existingUser.disabled || existingUser.roles.includes('ADMIN')))
      throw denied();
    const nativeUser =
      existingUser ||
      (await tx.user.create({
        data: {
          email: grant.email,
          name: grant.name,
          emailVerified: new Date(),
          password: null,
          source: 'homix-portal',
        },
      }));
    if (!account) {
      await tx.account.create({
        data: {
          type: 'oauth',
          provider: 'google',
          providerAccountId: identity.googleSubject,
          userId: nativeUser.id,
        },
      });
    }
    if (
      mapping &&
      (mapping.grantId !== grant.grantId ||
        mapping.googleSubject !== identity.googleSubject ||
        nativeUser.email.toLowerCase() !== grant.email)
    ) {
      await tx.session.deleteMany({ where: { userId: nativeUser.id } });
    }
    if (existingUser) {
      // Only a verified Google callback can synchronize the managed account email.
      // Never keep password credentials from an earlier email/identity binding.
      await tx.user.update({
        where: { id: nativeUser.id },
        data: { email: grant.email, emailVerified: new Date(), password: null },
      });
    }
    await tx.portalSigningIdentity.upsert({
      where: { portalAgentId: grant.agentId },
      create: {
        portalAgentId: grant.agentId,
        userId: nativeUser.id,
        googleSubject: identity.googleSubject,
        email: grant.email,
        grantId: grant.grantId,
      },
      update: { googleSubject: identity.googleSubject, email: grant.email, grantId: grant.grantId },
    });
    return nativeUser;
  });

  // Deterministic URLs make partial failures retryable. Do not swallow org/team
  // errors, and do not issue a session until the private workspace is ready.
  const workspaceUrl = `homix-personal-${grant.agentId}`;
  let organisation = await prisma.organisation.findUnique({ where: { url: workspaceUrl } });
  if (!organisation) {
    try {
      organisation = await createOrganisation({
        userId: user.id,
        name: 'My signing workspace',
        url: workspaceUrl,
        type: 'PERSONAL',
        claim: internalClaims[INTERNAL_CLAIM_ID.FREE],
      });
    } catch (error) {
      organisation = await prisma.organisation.findUnique({ where: { url: workspaceUrl } });
      if (!organisation) throw error;
    }
  }
  if (organisation.ownerUserId !== user.id || organisation.type !== 'PERSONAL') throw denied();
  const otherMembers = await prisma.organisationMember.count({
    where: { organisationId: organisation.id, userId: { not: user.id } },
  });
  if (otherMembers !== 0) throw denied();
  let team = await prisma.team.findUnique({ where: { url: workspaceUrl } });
  if (!team) {
    try {
      await createTeam({
        userId: user.id,
        teamName: 'My documents',
        teamUrl: workspaceUrl,
        organisationId: organisation.id,
        inheritMembers: false,
      });
    } catch (error) {
      team = await prisma.team.findUnique({ where: { url: workspaceUrl } });
      if (!team) throw error;
    }
    team = await prisma.team.findUnique({ where: { url: workspaceUrl } });
  }
  if (!team || team.organisationId !== organisation.id) throw denied();
  await prisma.teamGlobalSettings.update({
    where: { id: team.teamGlobalSettingsId },
    data: { documentVisibility: 'ADMIN', delegateDocumentOwnership: true },
  });
  await assertPersonalUserAccess(user.id);
  return { userId: user.id, redirectPath: `/t/${workspaceUrl}/documents` };
}
