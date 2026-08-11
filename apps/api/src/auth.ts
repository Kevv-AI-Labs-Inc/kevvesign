import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
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

const OidcProviderConfigSchema = z.object({
  id: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  issuer: z.string().url(),
  audience: z.string().min(1).max(500),
  jwksUrl: z.string().url(),
  subjectClaim: z.string().min(1).max(80).default('sub'),
  emailClaim: z.string().min(1).max(80).default('email'),
  emailVerifiedClaim: z.string().min(1).max(80).optional(),
});

type OidcProviderConfig = z.infer<typeof OidcProviderConfigSchema>;

interface VerifiedIdentity {
  providerId: string;
  subject: string;
  email: string;
}

interface IdentityProvider {
  readonly id: string;
  verify(token: string): Promise<VerifiedIdentity | undefined>;
}

class OidcIdentityProvider implements IdentityProvider {
  readonly id: string;
  private readonly jwks;

  constructor(private readonly definition: OidcProviderConfig) {
    this.id = definition.id;
    const jwksUrl = new URL(definition.jwksUrl);
    const issuer = new URL(definition.issuer);
    if (
      jwksUrl.protocol !== 'https:' ||
      issuer.protocol !== 'https:' ||
      jwksUrl.username ||
      jwksUrl.password ||
      jwksUrl.search ||
      jwksUrl.hash ||
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash
    ) {
      throw new Error(`OIDC provider ${definition.id} must use credential-free HTTPS URLs.`);
    }
    this.jwks = createRemoteJWKSet(jwksUrl);
  }

  async verify(token: string): Promise<VerifiedIdentity | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.definition.issuer,
        audience: this.definition.audience,
      });
      const subject = payload[this.definition.subjectClaim];
      const email = payload[this.definition.emailClaim];
      if (
        this.definition.emailVerifiedClaim &&
        payload[this.definition.emailVerifiedClaim] !== true
      ) {
        return undefined;
      }
      if (typeof subject !== 'string' || typeof email !== 'string') return undefined;
      return { providerId: this.id, subject, email };
    } catch {
      return undefined;
    }
  }
}

function identityProviders(config: AppConfig): IdentityProvider[] {
  let definitions: OidcProviderConfig[];
  try {
    definitions = z
      .array(OidcProviderConfigSchema)
      .max(20)
      .parse(JSON.parse(config.OIDC_PROVIDERS_JSON));
  } catch {
    throw new Error('OIDC_PROVIDERS_JSON must contain a valid array of OIDC provider definitions.');
  }
  if (config.ENTRA_TENANT_ID && config.ENTRA_CLIENT_ID) {
    definitions.push({
      id: 'entra',
      issuer: `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}/v2.0`,
      audience: config.ENTRA_CLIENT_ID,
      jwksUrl: `https://login.microsoftonline.com/${config.ENTRA_TENANT_ID}/discovery/v2.0/keys`,
      subjectClaim: 'oid',
      emailClaim: 'preferred_username',
    });
  }
  const unique = new Map(definitions.map((definition) => [definition.id, definition]));
  if (unique.size !== definitions.length) throw new Error('OIDC provider IDs must be unique.');
  return [...unique.values()].map((definition) => new OidcIdentityProvider(definition));
}

export class StaffAuthenticator {
  private readonly providers: IdentityProvider[];

  constructor(
    private readonly config: AppConfig,
    private readonly repository: PlatformRepository,
  ) {
    this.providers = identityProviders(config);
  }

  async authenticate(request: FastifyRequest): Promise<StaffPrincipal> {
    const delegatedSessionSecret = request.cookies?.esign_staff;
    if (delegatedSessionSecret) {
      return this.repository.read((state) => {
        const session = findStaffSession(state, delegatedSessionSecret, new Date());
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
          actorType: 'integration',
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
    if (!header?.startsWith('Bearer ') || this.providers.length === 0) {
      throw new DomainError('unauthorized', 'Authentication is required.', 401);
    }
    let identity: VerifiedIdentity | undefined;
    for (const provider of this.providers) {
      identity = await provider.verify(header.slice(7));
      if (identity) break;
    }
    if (!identity) throw new DomainError('unauthorized', 'Authentication is invalid.', 401);
    return this.repository.read((state) => {
      for (const workspace of state.workspaces) {
        const member = workspace.members.find(
          (candidate) =>
            candidate.email.toLowerCase() === identity.email.toLowerCase() &&
            candidate.status === 'ACTIVE',
        );
        if (member) {
          return {
            id: member.id,
            email: member.email,
            displayName: member.displayName,
            role: member.role as StaffRole,
            workspaceId: workspace.id,
            actorType: 'staff',
            identityProviderId: identity.providerId,
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
