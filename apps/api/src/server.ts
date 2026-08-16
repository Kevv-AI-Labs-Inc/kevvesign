import path from 'node:path';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError, z } from 'zod';
import {
  ConsentInputSchema,
  CreateApplicationClientInputSchema,
  CreateEnvelopeInputSchema,
  CreateIntegrationSessionInputSchema,
  CreateTemplateInputSchema,
  CreateTransactionInputSchema,
  SaveSigningProgressSchema,
  UpdateTemplateDraftInputSchema,
  type ApplicationScope,
  type StaffPrincipal,
} from '@esign/contracts';
import {
  DomainError,
  seedState,
  safeSecretEqual,
  sha256,
  systemClock,
  type EmailPort,
  type FileScanner,
  type ManifestSigner,
  type ObjectStore,
  type PlatformRepository,
} from '@esign/domain';
import {
  AzureBlobObjectStore,
  AzureCommunicationEmailPort,
  AzureKeyVaultManifestSigner,
  AzureSqlStateRepository,
  HmacManifestSigner,
  JsonFileRepository,
  ClamAvFileScanner,
  LocalEmailPort,
  LocalFileScanner,
  LocalObjectStore,
  PlatformEvidenceFinalizer,
  DocumensoSigningEngine,
} from '@esign/infrastructure';
import type { AppConfig } from './config.js';
import { ApplicationAuthenticator, StaffAuthenticator } from './auth.js';
import { ESignService, type RequestContext } from './services.js';

declare module 'fastify' {
  interface FastifyRequest {
    staff?: StaffPrincipal;
  }
}

const IdSchema = z.string().uuid();
const TokenSchema = z.string().min(30).max(200);
const SigningProviderConnectionIdSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const SigningEngineWebhookSchema = z.object({
  event: z
    .string()
    .min(3)
    .max(100)
    .regex(/^[A-Z0-9_]+$/),
  createdAt: z.string().datetime(),
  webhookEndpoint: z.string().url().optional(),
  payload: z
    .object({
      id: z.union([z.string(), z.number()]).optional(),
      envelopeId: z.string().min(1).max(120).optional(),
      externalId: z.string().max(120).nullable().optional(),
      status: z.string().max(40).optional(),
      completedAt: z.string().datetime().nullable().optional(),
      recipients: z
        .array(
          z.object({
            id: z.union([z.string(), z.number()]).optional(),
            email: z.string().email().max(254),
            readStatus: z.string().max(40).optional(),
            signingStatus: z.string().max(40).optional(),
            signedAt: z.string().datetime().nullable().optional(),
          }),
        )
        .max(100)
        .optional(),
      Recipient: z
        .array(
          z.object({
            id: z.union([z.string(), z.number()]).optional(),
            email: z.string().email().max(254),
            readStatus: z.string().max(40).optional(),
            signingStatus: z.string().max(40).optional(),
            signedAt: z.string().datetime().nullable().optional(),
          }),
        )
        .max(100)
        .optional(),
    })
    .passthrough()
    .refine((payload) => payload.envelopeId !== undefined || payload.id !== undefined, {
      message: 'A signing-engine envelope identifier is required.',
    }),
});

function requestContext(request: FastifyRequest): RequestContext {
  return {
    requestId: request.id,
    ip: request.ip,
    userAgent: request.headers['user-agent']?.slice(0, 500),
  };
}

function success<T>(data: T) {
  return { data };
}

function parseId(value: unknown): string {
  return IdSchema.parse(value);
}

function parseMultipartJson(value: unknown): unknown {
  try {
    return JSON.parse(String(value));
  } catch {
    throw new DomainError('invalid_metadata', 'Template metadata must be valid JSON.', 422);
  }
}

function safeDownloadName(value: string): string {
  return path
    .basename(value)
    .replace(/["\\\r\n]/g, '_')
    .slice(0, 180);
}

function getSession(request: FastifyRequest): { session: string; csrf: string } {
  const session = request.cookies.esign_recipient;
  const csrf = request.headers['x-csrf-token'];
  if (!session || typeof csrf !== 'string')
    throw new DomainError('recipient_session_invalid', 'Signing session is unavailable.', 401);
  return { session, csrf };
}

export interface ApplicationDependencies {
  repository: PlatformRepository;
  objects: ObjectStore;
  email: EmailPort;
  signer: ManifestSigner;
  scanner: FileScanner;
  signingEngines?: ReadonlyMap<string, import('@esign/domain').SigningEngine>;
  /** SHA-256 hashes only; plaintext webhook secrets never enter platform state. */
  signingEngineWebhookSecretHashes?: ReadonlyMap<string, string>;
  /** @deprecated Test compatibility; wrapped in the configured connection ID. */
  signingEngine?: import('@esign/domain').SigningEngine;
}

export function createDependencies(config: AppConfig): ApplicationDependencies {
  const dataDir = path.resolve(config.DATA_DIR);
  const repository: PlatformRepository =
    config.DATABASE_DRIVER === 'azure-sql'
      ? new AzureSqlStateRepository(config.AZURE_SQL_CONNECTION_STRING ?? '')
      : new JsonFileRepository(path.join(dataDir, 'platform-state.json'), seedState);
  const objects: ObjectStore =
    config.STORAGE_DRIVER === 'azure'
      ? new AzureBlobObjectStore(
          config.AZURE_STORAGE_ACCOUNT_URL ?? '',
          `${config.AZURE_STORAGE_CONTAINER_PREFIX}-objects`,
        )
      : new LocalObjectStore(path.join(dataDir, 'objects'));
  const email: EmailPort =
    config.EMAIL_DRIVER === 'azure'
      ? new AzureCommunicationEmailPort(
          config.ACS_EMAIL_CONNECTION_STRING ?? '',
          config.ACS_EMAIL_SENDER ?? '',
        )
      : new LocalEmailPort(path.join(dataDir, 'outbox'));
  const signer: ManifestSigner =
    config.SIGNING_DRIVER === 'azure'
      ? new AzureKeyVaultManifestSigner(
          config.AZURE_KEY_VAULT_URL ?? '',
          config.AZURE_MANIFEST_KEY_NAME,
        )
      : new HmacManifestSigner(config.SESSION_SECRET);
  const scanner: FileScanner =
    config.NODE_ENV === 'production'
      ? new ClamAvFileScanner(config.CLAMAV_HOST, config.CLAMAV_PORT)
      : new LocalFileScanner();
  const signingEngines = new Map<string, import('@esign/domain').SigningEngine>();
  const signingEngineWebhookSecretHashes = new Map<string, string>();
  if (config.SIGNING_ENGINE_PROVIDER === 'documenso') {
    signingEngines.set(
      config.SIGNING_PROVIDER_CONNECTION_ID,
      new DocumensoSigningEngine(
        config.DOCUMENSO_BASE_URL ?? '',
        config.DOCUMENSO_API_TOKEN ?? '',
        config.DOCUMENSO_REQUEST_TIMEOUT_MS,
      ),
    );
    signingEngineWebhookSecretHashes.set(
      config.SIGNING_PROVIDER_CONNECTION_ID,
      sha256(config.DOCUMENSO_WEBHOOK_SECRET ?? ''),
    );
  }
  return {
    repository,
    objects,
    email,
    signer,
    scanner,
    signingEngines,
    signingEngineWebhookSecretHashes,
  };
}

export async function buildServer(config: AppConfig, dependencies = createDependencies(config)) {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.x-esign-key',
          'req.headers.x-csrf-token',
          'req.url',
          'res.headers.set-cookie',
          '*.token',
          '*.ticket',
          '*.signature',
          '*.accessCode',
          'req.headers.x-documenso-secret',
        ],
        censor: '[REDACTED]',
      },
    },
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });
  await app.register(cookie, { secret: config.SESSION_SECRET, hook: 'onRequest' });
  await app.register(cors, {
    origin: config.WEB_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', ban: 3 });
  await app.register(multipart, {
    limits: { files: 1, fileSize: 30 * 1024 * 1024, fields: 10, parts: 12 },
    attachFieldsToBody: false,
  });
  const authenticator = new StaffAuthenticator(config, dependencies.repository);
  const applicationAuthenticator = new ApplicationAuthenticator(dependencies.repository);
  const finalizer = new PlatformEvidenceFinalizer(
    dependencies.repository,
    dependencies.objects,
    dependencies.signer,
  );
  const signingEngines =
    dependencies.signingEngines ??
    (dependencies.signingEngine
      ? new Map([[config.SIGNING_PROVIDER_CONNECTION_ID, dependencies.signingEngine]])
      : new Map());
  const signingEngineWebhookSecretHashes =
    dependencies.signingEngineWebhookSecretHashes ??
    (config.SIGNING_ENGINE_PROVIDER === 'documenso' && config.DOCUMENSO_WEBHOOK_SECRET
      ? new Map([[config.SIGNING_PROVIDER_CONNECTION_ID, sha256(config.DOCUMENSO_WEBHOOK_SECRET)]])
      : new Map());
  const service = new ESignService(
    dependencies.repository,
    dependencies.objects,
    dependencies.email,
    finalizer,
    dependencies.scanner,
    config.PUBLIC_BASE_URL,
    systemClock,
    config.LAUNCH_SESSION_TTL_SECONDS,
    config.STAFF_SESSION_TTL_SECONDS,
    signingEngines,
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed.',
          requestId: request.id,
          details: error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
            code: issue.code,
          })),
        },
      });
    }
    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return reply.status(error.statusCode).send({
        error: {
          code: 'invalid_request',
          message: 'The request could not be parsed.',
          requestId: request.id,
        },
      });
    }
    request.log.error({ err: error, requestId: request.id }, 'Unhandled request error');
    return reply.status(500).send({
      error: {
        code: 'internal_error',
        message: 'An unexpected error occurred.',
        requestId: request.id,
      },
    });
  });

  const staff = async (request: FastifyRequest) => {
    request.staff = await authenticator.authenticate(request);
  };
  const staffOrApplication = (scope: ApplicationScope) => async (request: FastifyRequest) => {
    request.staff = request.headers['x-esign-key']
      ? await applicationAuthenticator.authenticate(request, scope)
      : await authenticator.authenticate(request);
  };
  const application = (scope: ApplicationScope) => async (request: FastifyRequest) => {
    request.staff = await applicationAuthenticator.authenticate(request, scope);
  };

  app.get('/health', async () => ({
    status: 'ok',
    service: 'esign-api',
    time: new Date().toISOString(),
  }));
  app.get('/v1/signing-engine/health', { preHandler: staff }, async (request) =>
    success(await service.signingEngineHealth(request.staff!)),
  );
  const receiveDocumensoWebhook = async (connectionId: string, request: FastifyRequest) => {
    const expectedSecretHash = signingEngineWebhookSecretHashes.get(connectionId);
    if (!expectedSecretHash || !signingEngines.has(connectionId)) {
      throw new DomainError('not_found', 'Resource not found.', 404);
    }
    const received = request.headers['x-documenso-secret'];
    if (typeof received !== 'string' || !safeSecretEqual(received, expectedSecretHash)) {
      throw new DomainError('unauthorized', 'Webhook authentication failed.', 401);
    }
    const event = SigningEngineWebhookSchema.parse(request.body);
    const recipients = event.payload.recipients ?? event.payload.Recipient;
    return success(
      await service.handleSigningEngineEvent(
        connectionId,
        {
          event: event.event,
          createdAt: event.createdAt,
          payload: {
            envelopeId: String(event.payload.envelopeId ?? event.payload.id),
            ...(event.payload.externalId !== undefined
              ? { externalId: event.payload.externalId }
              : {}),
            ...(event.payload.status !== undefined ? { status: event.payload.status } : {}),
            ...(event.payload.completedAt !== undefined
              ? { completedAt: event.payload.completedAt }
              : {}),
            ...(recipients !== undefined ? { recipients } : {}),
          },
        },
        requestContext(request),
      ),
    );
  };
  app.post(
    '/v1/signing-engine/webhooks/documenso',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    (request) => receiveDocumensoWebhook(config.SIGNING_PROVIDER_CONNECTION_ID, request),
  );
  app.post(
    '/v1/signing-engine/webhooks/documenso/:connectionId',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    (request) => {
      const { connectionId } = request.params as { connectionId: string };
      return receiveDocumensoWebhook(
        SigningProviderConnectionIdSchema.parse(connectionId),
        request,
      );
    },
  );
  app.get('/docs/openapi.json', async (_request, reply) =>
    reply.type('application/json').send(OPENAPI),
  );

  app.get('/v1/me', { preHandler: staff }, async (request) => success(request.staff));
  app.get('/v1/dashboard', { preHandler: staff }, async (request) =>
    success(await service.dashboard(request.staff!)),
  );

  app.get('/v1/application-clients', { preHandler: staff }, async (request) =>
    success(await service.listApplicationClients(request.staff!)),
  );
  app.post('/v1/application-clients', { preHandler: staff }, async (request, reply) => {
    const result = await service.createApplicationClient(
      request.staff!,
      CreateApplicationClientInputSchema.parse(request.body),
      requestContext(request),
    );
    return reply
      .status(201)
      .header('cache-control', 'no-store')
      .header('location', `/v1/application-clients/${result.client.id}`)
      .send(success(result));
  });
  app.post(
    '/v1/application-clients/:clientId/rotate',
    { preHandler: staff },
    async (request, reply) => {
      const { clientId } = request.params as { clientId: string };
      const result = await service.rotateApplicationClient(
        request.staff!,
        parseId(clientId),
        requestContext(request),
      );
      return reply.header('cache-control', 'no-store').send(success(result));
    },
  );
  app.post('/v1/application-clients/:clientId/revoke', { preHandler: staff }, async (request) => {
    const { clientId } = request.params as { clientId: string };
    return success(
      await service.revokeApplicationClient(
        request.staff!,
        parseId(clientId),
        requestContext(request),
      ),
    );
  });

  const createIntegrationSession = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await service.createIntegrationSession(
      request.staff!,
      CreateIntegrationSessionInputSchema.parse(request.body),
      requestContext(request),
    );
    return reply
      .status(201)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .send(success(result));
  };
  app.post(
    '/v1/integration-sessions',
    {
      preHandler: application('integration-sessions:create'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    createIntegrationSession,
  );
  app.post(
    '/v1/portal-sessions',
    {
      preHandler: application('portal-sessions:create'),
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      reply
        .header('deprecation', 'true')
        .header('link', '</v1/integration-sessions>; rel="successor-version"');
      return createIntegrationSession(request, reply);
    },
  );
  app.post(
    '/v1/integration-sessions/exchange',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const body = z.object({ ticket: TokenSchema }).parse(request.body);
      const result = await service.exchangeIntegrationSession(body.ticket, requestContext(request));
      const secure = config.NODE_ENV === 'production';
      const maxAge = Math.max(
        1,
        Math.floor((new Date(result.exchange.expiresAt).getTime() - Date.now()) / 1000),
      );
      reply.setCookie('esign_staff', result.sessionSecret, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge,
      });
      reply.setCookie('esign_staff_csrf', result.exchange.csrfToken, {
        httpOnly: false,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge,
      });
      return reply
        .header('cache-control', 'no-store')
        .header('referrer-policy', 'no-referrer')
        .send(success(result.exchange));
    },
  );
  app.post('/v1/integration-sessions/logout', { preHandler: staff }, async (request, reply) => {
    const sessionSecret = request.cookies.esign_staff;
    if (!sessionSecret)
      throw new DomainError('staff_session_invalid', 'Staff session is unavailable.', 401);
    const result = await service.logoutIntegrationSession(
      request.staff!,
      sessionSecret,
      requestContext(request),
    );
    reply.clearCookie('esign_staff', { path: '/' });
    reply.clearCookie('esign_staff_csrf', { path: '/' });
    return success(result);
  });

  // Deprecated aliases remain for already-issued Homix clients while all new callers use the
  // provider-neutral integration contract.
  app.post(
    '/v1/portal-sessions/exchange',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      reply.header('deprecation', 'true');
      const body = z.object({ ticket: TokenSchema }).parse(request.body);
      const result = await service.exchangeIntegrationSession(body.ticket, requestContext(request));
      const secure = config.NODE_ENV === 'production';
      const maxAge = Math.max(
        1,
        Math.floor((new Date(result.exchange.expiresAt).getTime() - Date.now()) / 1000),
      );
      reply.setCookie('esign_staff', result.sessionSecret, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge,
      });
      reply.setCookie('esign_staff_csrf', result.exchange.csrfToken, {
        httpOnly: false,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge,
      });
      return reply.header('cache-control', 'no-store').send(success(result.exchange));
    },
  );
  app.post('/v1/portal-sessions/logout', { preHandler: staff }, async (request, reply) => {
    reply.header('deprecation', 'true');
    const sessionSecret = request.cookies.esign_staff;
    if (!sessionSecret) {
      throw new DomainError('staff_session_invalid', 'Staff session is unavailable.', 401);
    }
    const result = await service.logoutIntegrationSession(
      request.staff!,
      sessionSecret,
      requestContext(request),
    );
    reply.clearCookie('esign_staff', { path: '/' });
    reply.clearCookie('esign_staff_csrf', { path: '/' });
    return success(result);
  });

  app.get('/v1/templates', { preHandler: staffOrApplication('templates:read') }, async (request) =>
    success(await service.listTemplates(request.staff!)),
  );
  app.get(
    '/v1/templates/:templateId',
    { preHandler: staffOrApplication('templates:read') },
    async (request) => {
      const { templateId } = request.params as { templateId: string };
      return success(await service.getTemplate(request.staff!, parseId(templateId)));
    },
  );
  app.post(
    '/v1/templates',
    { preHandler: staff, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      let metadata: unknown;
      let uploaded: { bytes: Uint8Array; filename: string; mimetype: string } | undefined;
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          uploaded = {
            bytes: await part.toBuffer(),
            filename: part.filename,
            mimetype: part.mimetype,
          };
        } else if (part.fieldname === 'metadata') {
          metadata = parseMultipartJson(part.value);
        }
      }
      if (!uploaded) throw new DomainError('file_required', 'A PDF file is required.', 422);
      const template = await service.createTemplate(
        request.staff!,
        CreateTemplateInputSchema.parse(metadata),
        uploaded,
        requestContext(request),
      );
      return reply
        .status(201)
        .header('location', `/v1/templates/${template.id}`)
        .send(success(template));
    },
  );
  app.patch(
    '/v1/templates/:templateId/versions/:versionId',
    { preHandler: staff },
    async (request) => {
      const params = request.params as { templateId: string; versionId: string };
      return success(
        await service.updateDraft(
          request.staff!,
          parseId(params.templateId),
          parseId(params.versionId),
          UpdateTemplateDraftInputSchema.parse(request.body),
          requestContext(request),
        ),
      );
    },
  );
  app.post(
    '/v1/templates/:templateId/versions/:versionId/documents',
    { preHandler: staff },
    async (request, reply) => {
      const params = request.params as { templateId: string; versionId: string };
      let uploaded: { bytes: Uint8Array; filename: string; mimetype: string } | undefined;
      let retentionClass = 'real-estate-7y';
      for await (const part of request.parts()) {
        if (part.type === 'file')
          uploaded = {
            bytes: await part.toBuffer(),
            filename: part.filename,
            mimetype: part.mimetype,
          };
        else if (part.fieldname === 'retentionClass') retentionClass = String(part.value);
      }
      if (!uploaded) throw new DomainError('file_required', 'A PDF file is required.', 422);
      const document = await service.addTemplateDocument(
        request.staff!,
        parseId(params.templateId),
        parseId(params.versionId),
        uploaded,
        retentionClass,
        requestContext(request),
      );
      return reply.status(201).send(success(document));
    },
  );
  app.post(
    '/v1/templates/:templateId/versions/:versionId/publish',
    { preHandler: staff },
    async (request) => {
      const params = request.params as { templateId: string; versionId: string };
      return success(
        await service.publishTemplate(
          request.staff!,
          parseId(params.templateId),
          parseId(params.versionId),
          requestContext(request),
        ),
      );
    },
  );
  app.post(
    '/v1/templates/:templateId/versions/:versionId/clone',
    { preHandler: staff },
    async (request, reply) => {
      const params = request.params as { templateId: string; versionId: string };
      return reply
        .status(201)
        .send(
          success(
            await service.cloneTemplateVersion(
              request.staff!,
              parseId(params.templateId),
              parseId(params.versionId),
            ),
          ),
        );
    },
  );
  app.post(
    '/v1/templates/:templateId/versions/:versionId/retire',
    { preHandler: staff },
    async (request) => {
      const params = request.params as { templateId: string; versionId: string };
      return success(
        await service.retireTemplateVersion(
          request.staff!,
          parseId(params.templateId),
          parseId(params.versionId),
        ),
      );
    },
  );
  app.get(
    '/v1/templates/:templateId/documents/:documentId',
    { preHandler: staffOrApplication('templates:read') },
    async (request, reply) => {
      const params = request.params as { templateId: string; documentId: string };
      const bytes = await service.templateDocument(
        request.staff!,
        parseId(params.templateId),
        parseId(params.documentId),
      );
      return reply
        .header('cache-control', 'private, no-store')
        .type('application/pdf')
        .send(Buffer.from(bytes));
    },
  );

  app.get(
    '/v1/transactions',
    { preHandler: staffOrApplication('transactions:read') },
    async (request) => success(await service.listTransactions(request.staff!)),
  );
  app.post(
    '/v1/transactions',
    { preHandler: staffOrApplication('transactions:write') },
    async (request, reply) => {
      const transaction = await service.createTransaction(
        request.staff!,
        CreateTransactionInputSchema.parse(request.body),
        requestContext(request),
      );
      return reply
        .status(201)
        .header('location', `/v1/transactions/${transaction.id}`)
        .send(success(transaction));
    },
  );

  app.get('/v1/envelopes', { preHandler: staffOrApplication('envelopes:read') }, async (request) =>
    success(await service.listEnvelopes(request.staff!)),
  );
  app.get(
    '/v1/envelopes/:envelopeId',
    { preHandler: staffOrApplication('envelopes:read') },
    async (request) => {
      const { envelopeId } = request.params as { envelopeId: string };
      return success(await service.getEnvelope(request.staff!, parseId(envelopeId)));
    },
  );
  app.post(
    '/v1/envelopes',
    { preHandler: staffOrApplication('envelopes:write') },
    async (request, reply) => {
      const envelope = await service.createEnvelope(
        request.staff!,
        CreateEnvelopeInputSchema.parse(request.body),
        String(request.headers['idempotency-key'] ?? ''),
        requestContext(request),
      );
      return reply
        .status(201)
        .header('location', `/v1/envelopes/${envelope.id}`)
        .send(success(envelope));
    },
  );
  app.post('/v1/envelopes/:envelopeId/approve', { preHandler: staff }, async (request) => {
    const { envelopeId } = request.params as { envelopeId: string };
    return success(
      await service.approveEnvelope(request.staff!, parseId(envelopeId), requestContext(request)),
    );
  });
  app.post(
    '/v1/envelopes/:envelopeId/send',
    { preHandler: staffOrApplication('envelopes:send') },
    async (request) => {
      const { envelopeId } = request.params as { envelopeId: string };
      const result = await service.sendEnvelope(
        request.staff!,
        parseId(envelopeId),
        String(request.headers['idempotency-key'] ?? ''),
        requestContext(request),
      );
      return success({
        envelope: result.envelope,
        replayed: result.replayed,
        ...(config.NODE_ENV === 'development' ? { invitationUrls: result.invitationUrls } : {}),
      });
    },
  );
  app.post(
    '/v1/envelopes/:envelopeId/void',
    { preHandler: staffOrApplication('envelopes:write') },
    async (request) => {
      const { envelopeId } = request.params as { envelopeId: string };
      const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
      return success(
        await service.voidEnvelope(
          request.staff!,
          parseId(envelopeId),
          body.reason,
          requestContext(request),
        ),
      );
    },
  );
  app.post(
    '/v1/envelopes/:envelopeId/recipients/:recipientId/resend',
    { preHandler: staffOrApplication('envelopes:send') },
    async (request) => {
      const params = request.params as { envelopeId: string; recipientId: string };
      const result = await service.resendEnvelope(
        request.staff!,
        parseId(params.envelopeId),
        parseId(params.recipientId),
      );
      return success(config.NODE_ENV === 'development' ? result : { sent: true });
    },
  );
  app.get(
    '/v1/envelopes/:envelopeId/evidence',
    { preHandler: staffOrApplication('evidence:read') },
    async (request) => {
      const { envelopeId } = request.params as { envelopeId: string };
      return success(await service.evidence(request.staff!, parseId(envelopeId)));
    },
  );
  app.get(
    '/v1/envelopes/:envelopeId/evidence/:filename',
    { preHandler: staffOrApplication('evidence:read') },
    async (request, reply) => {
      const params = request.params as { envelopeId: string; filename: string };
      const filename = safeDownloadName(params.filename);
      const bytes = await service.evidenceFile(
        request.staff!,
        parseId(params.envelopeId),
        filename,
      );
      return reply
        .header('content-disposition', `attachment; filename="${filename}"`)
        .type(filename.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream')
        .send(Buffer.from(bytes));
    },
  );

  app.get(
    '/v1/invitations/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request) => {
      const { token } = request.params as { token: string };
      return success(await service.invitationStatus(TokenSchema.parse(token)));
    },
  );
  app.post(
    '/v1/signing/session/exchange',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const body = z
        .object({ token: TokenSchema, accessCode: z.string().max(32).optional() })
        .parse(request.body);
      const result = await service.exchangeInvitation(
        body.token,
        body.accessCode,
        requestContext(request),
      );
      const secure = config.NODE_ENV === 'production';
      reply.setCookie('esign_recipient', result.sessionSecret, {
        httpOnly: true,
        secure,
        sameSite: 'strict',
        path: '/v1/signing',
        maxAge: 3600,
      });
      reply.setCookie('esign_csrf', result.csrfToken, {
        httpOnly: false,
        secure,
        sameSite: 'strict',
        path: '/',
        maxAge: 3600,
      });
      return success(result.context);
    },
  );
  app.get('/v1/signing/context', async (request) => {
    const session = request.cookies.esign_recipient;
    const csrf = request.cookies.esign_csrf;
    if (!session || !csrf)
      throw new DomainError('recipient_session_invalid', 'Signing session is unavailable.', 401);
    return success(await service.getSigningContext(session, csrf));
  });
  app.post('/v1/signing/consent', async (request) => {
    const credentials = getSession(request);
    const body = ConsentInputSchema.parse(request.body);
    return success(
      await service.consent(
        credentials.session,
        credentials.csrf,
        body.disclosureVersion,
        requestContext(request),
      ),
    );
  });
  app.post('/v1/signing/progress', async (request) => {
    const credentials = getSession(request);
    return success(
      await service.saveProgress(
        credentials.session,
        credentials.csrf,
        SaveSigningProgressSchema.parse(request.body),
        requestContext(request),
      ),
    );
  });
  app.post('/v1/signing/finish', async (request, reply) => {
    const credentials = getSession(request);
    const context = await service.finish(
      credentials.session,
      credentials.csrf,
      requestContext(request),
    );
    reply.clearCookie('esign_recipient', { path: '/v1/signing' });
    reply.clearCookie('esign_csrf', { path: '/' });
    return success(context);
  });
  app.post('/v1/signing/decline', async (request, reply) => {
    const credentials = getSession(request);
    const body = z.object({ reason: z.string().max(500).default('') }).parse(request.body);
    await service.decline(
      credentials.session,
      credentials.csrf,
      body.reason,
      requestContext(request),
    );
    reply.clearCookie('esign_recipient', { path: '/v1/signing' });
    reply.clearCookie('esign_csrf', { path: '/' });
    return reply.status(204).send();
  });
  app.get('/v1/signing/documents/:documentId', async (request, reply) => {
    const session = request.cookies.esign_recipient;
    if (!session)
      throw new DomainError('recipient_session_invalid', 'Signing session is unavailable.', 401);
    const { documentId } = request.params as { documentId: string };
    const bytes = await service.signingDocument(session, parseId(documentId));
    return reply
      .header('cache-control', 'private, no-store')
      .type('application/pdf')
      .send(Buffer.from(bytes));
  });

  return app;
}

const OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'Internal E-Sign API', version: '2026-08-01' },
  servers: [{ url: '/v1' }],
  security: [{ oidcBearer: [] }, { staffSession: [] }],
  paths: {
    '/application-clients': {
      get: { summary: 'List application credentials (staff only)' },
      post: { summary: 'Issue a one-time application credential (staff only)' },
    },
    '/application-clients/{clientId}/rotate': {
      post: { summary: 'Rotate an application credential (staff only)' },
    },
    '/application-clients/{clientId}/revoke': {
      post: { summary: 'Revoke an application credential (staff only)' },
    },
    '/integration-sessions': {
      post: {
        summary: 'Create a short-lived connected-system editor launch',
        security: [{ applicationKey: [] }],
      },
    },
    '/integration-sessions/exchange': {
      post: { summary: 'Exchange a one-time integration launch ticket for a staff session' },
    },
    '/signing-engine/health': {
      get: { summary: 'Check the configured signing-engine connection' },
    },
    '/signing-engine/webhooks/documenso': {
      post: {
        summary: 'Receive an authenticated Documenso lifecycle event',
        security: [{ documensoWebhookSecret: [] }],
      },
    },
    '/signing-engine/webhooks/documenso/{connectionId}': {
      post: {
        summary: 'Receive a connection-scoped authenticated Documenso lifecycle event',
        security: [{ documensoWebhookSecret: [] }],
      },
    },
    '/templates': {
      get: {
        summary: 'List templates',
        security: [{ oidcBearer: [] }, { applicationKey: [] }],
      },
      post: { summary: 'Upload and create a template' },
    },
    '/envelopes': {
      get: {
        summary: 'List envelopes',
        security: [{ oidcBearer: [] }, { applicationKey: [] }],
      },
      post: {
        summary: 'Create an envelope',
        security: [{ oidcBearer: [] }, { applicationKey: [] }],
      },
    },
    '/envelopes/{envelopeId}/send': {
      post: {
        summary: 'Send an envelope idempotently',
        security: [{ oidcBearer: [] }, { applicationKey: [] }],
      },
    },
    '/envelopes/{envelopeId}/void': {
      post: {
        summary: 'Void an envelope',
        security: [{ oidcBearer: [] }, { applicationKey: [] }],
      },
    },
    '/envelopes/{envelopeId}/evidence': {
      get: {
        summary: 'Get evidence package metadata',
        security: [{ oidcBearer: [] }, { applicationKey: [] }],
      },
    },
    '/transactions': {
      get: {
        summary: 'List business transactions',
        security: [{ oidcBearer: [] }, { applicationKey: [] }],
      },
      post: {
        summary: 'Create a business transaction',
        security: [{ oidcBearer: [] }, { applicationKey: [] }],
      },
    },
  },
  components: {
    securitySchemes: {
      oidcBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      applicationKey: { type: 'apiKey', in: 'header', name: 'X-ESign-Key' },
      staffSession: { type: 'apiKey', in: 'cookie', name: 'esign_staff' },
      documensoWebhookSecret: { type: 'apiKey', in: 'header', name: 'X-Documenso-Secret' },
    },
  },
};
