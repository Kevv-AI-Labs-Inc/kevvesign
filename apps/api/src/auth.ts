import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type {
  ApplicationPrincipal,
  ApplicationScope,
  StaffPrincipal,
  StaffRole,
} from '@esign/contracts';
import {
  DomainError,
  findStaffSession,
  findWorkspace,
  safeSecretEqual,
  type PlatformRepository,
} from '@esign/domain';
import type { AppConfig } from './config.js';

const DEMO_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

export class StaffAuthenticator {
  private readonly jwks;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: PlatformRepository,
  ) {
    this.jwks = config.ENTRA_TENANT_ID
      ? createRemoteJWKSet(
          new URL(
            `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}/discovery/v2.0/keys`,
          ),
        )
      : undefined;
  }

  async authenticate(request: FastifyRequest): Promise<StaffPrincipal> {
    const portalSessionSecret = request.cookies?.esign_staff;
    if (portalSessionSecret) {
      return this.repository.read((state) => {
        const session = findStaffSession(state, portalSessionSecret, new Date());
        const client = (state.applicationClients ?? []).find(
          (candidate) =>
            candidate.id === session.applicationClientId &&
            candidate.workspaceId === session.workspaceId,
        );
        if (
          !client ||
          client.status !== 'ACTIVE' ||
          (client.expiresAt && new Date(client.expiresAt) <= new Date())
        ) {
          throw new DomainError('staff_session_invalid', 'Staff session is unavailable.', 401);
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
          const csrf = request.headers['x-csrf-token'];
          if (typeof csrf !== 'string' || !safeSecretEqual(csrf, session.csrfHash)) {
            throw new DomainError('csrf_invalid', 'Request verification failed.', 403);
          }
        }
        return {
          id: session.actor.subject,
          email: session.actor.email,
          displayName: session.actor.displayName,
          role: session.actor.role,
          workspaceId: session.workspaceId,
          actorType: 'portal',
          sourceApplicationClientId: client.id,
          sourceApplicationName: client.name,
          delegatedScopes: session.scopes,
          returnUrl: session.returnUrl,
        };
      });
    }
    if (this.config.NODE_ENV !== 'production') {
      return {
        id: '22222222-2222-4222-8222-222222222222',
        email: this.config.LOCAL_STAFF_EMAIL,
        displayName: 'Demo Administrator',
        role: this.config.LOCAL_STAFF_ROLE,
        workspaceId: DEMO_WORKSPACE_ID,
        actorType: 'staff',
      };
    }
    const header = request.headers.authorization;
    if (
      !header?.startsWith('Bearer ') ||
      !this.jwks ||
      !this.config.ENTRA_CLIENT_ID ||
      !this.config.ENTRA_TENANT_ID
    ) {
      throw new DomainError('unauthorized', 'Authentication is required.', 401);
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(header.slice(7), this.jwks, {
        issuer: `https://login.microsoftonline.com/${this.config.ENTRA_TENANT_ID}/v2.0`,
        audience: this.config.ENTRA_CLIENT_ID,
      }));
    } catch {
      throw new DomainError('unauthorized', 'Authentication is invalid.', 401);
    }
    const tenant = payload.tid;
    const subject = payload.oid ?? payload.sub;
    const email = payload.preferred_username ?? payload.email;
    if (
      tenant !== this.config.ENTRA_TENANT_ID ||
      typeof subject !== 'string' ||
      typeof email !== 'string'
    ) {
      throw new DomainError('unauthorized', 'Authentication is invalid.', 401);
    }
    return this.repository.read((state) => {
      for (const workspace of state.workspaces) {
        const member = workspace.members.find(
          (candidate) =>
            candidate.email.toLowerCase() === email.toLowerCase() && candidate.status === 'ACTIVE',
        );
        if (member) {
          return {
            id: member.id,
            email: member.email,
            displayName: member.displayName,
            role: member.role as StaffRole,
            workspaceId: workspace.id,
            actorType: 'staff',
          };
        }
      }
      findWorkspace(state, DEMO_WORKSPACE_ID);
      throw new DomainError('forbidden', 'No active e-sign workspace membership was found.', 403);
    });
  }
}

export class ApplicationAuthenticator {
  constructor(
    private readonly repository: PlatformRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authenticate(
    request: FastifyRequest,
    scope: ApplicationScope,
  ): Promise<ApplicationPrincipal> {
    const header = request.headers['x-esign-key'];
    if (typeof header !== 'string') {
      throw new DomainError('unauthorized', 'Application authentication is required.', 401);
    }
    const separator = header.indexOf('.');
    const clientId = separator > 0 ? header.slice(0, separator) : '';
    const secret = separator > 0 ? header.slice(separator + 1) : '';
    if (!clientId || secret.length < 30) {
      throw new DomainError('unauthorized', 'Application authentication is invalid.', 401);
    }
    return this.repository.read((state) => {
      const client = (state.applicationClients ?? []).find(
        (candidate) => candidate.id === clientId,
      );
      if (
        !client ||
        client.status !== 'ACTIVE' ||
        (client.expiresAt && new Date(client.expiresAt) <= this.now()) ||
        !safeSecretEqual(secret, client.secretHash)
      ) {
        throw new DomainError('unauthorized', 'Application authentication is invalid.', 401);
      }
      if (!client.scopes.includes(scope)) {
        throw new DomainError('forbidden', 'Application credential lacks the required scope.', 403);
      }
      return {
        id: client.id,
        email: `application:${client.id}`,
        displayName: client.name,
        role: 'preparer',
        workspaceId: client.workspaceId,
        actorType: 'application',
        scopes: client.scopes,
        delegatedScopes: client.scopes,
        sourceApplicationClientId: client.id,
        sourceApplicationName: client.name,
      };
    });
  }
}
