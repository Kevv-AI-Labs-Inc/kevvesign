import Fastify, { LogController } from 'fastify';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import type { BridgeConfig, Principal } from './config.js';
import { authenticate, webhookSecret, secretEquals } from './auth.js';
import { SigningService } from './service.js';
import { BridgeError, type FileInput } from './model.js';
import { ProviderError } from './documenso.js';
import { safeFilename, attachmentDisposition } from './review.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}
const idParams = z.object({ id: z.uuid() });
const partParams = idParams.extend({ partId: z.uuid() });

export async function buildServer(config: BridgeConfig, service: SigningService) {
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      redact: [
        'req.headers.authorization',
        'req.headers.x-portal-actor',
        'req.headers.x-documenso-secret',
        '*.token',
        '*.token_ciphertext',
      ],
    },
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
  });
  await app.register(rateLimit, {
    hook: 'preHandler',
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) =>
      request.principal ? `${request.principal.clientId}:${request.principal.agentId}` : request.ip,
  });
  await app.register(multipart, {
    limits: {
      files: 10,
      fileSize: 25 * 1024 * 1024,
      fields: 1,
      fieldSize: 128 * 1024,
      parts: 11,
    },
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    if (request.url.startsWith('/v1/')) request.principal = authenticate(request.headers, config);
  });
  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof BridgeError
        ? error.status
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? 400
          : error instanceof ProviderError
            ? error.status === 429
              ? 503
              : 502
            : (error as { code?: string }).code === '23505'
              ? 409
              : (error as { statusCode?: number }).statusCode === 413
                ? 413
                : (error as { statusCode?: number }).statusCode === 429
                  ? 429
                  : 500;
    const code =
      error instanceof BridgeError || error instanceof ProviderError
        ? error.code
        : status === 400
          ? 'INVALID_REQUEST'
          : status === 409
            ? 'RECORD_ALREADY_EXISTS'
            : status === 413
              ? 'UPLOAD_TOO_LARGE'
              : status === 429
                ? 'RATE_LIMITED'
                : 'SIGNING_REQUEST_FAILED';
    request.log.warn({ code, status }, 'Signing request rejected');
    reply.code(status).send({ error: code });
  });
  let lastReconcile = 0,
    reconciling = false,
    closing = false;
  async function tick() {
    if (reconciling || closing) return;
    reconciling = true;
    try {
      await service.reconcile();
      lastReconcile = Date.now();
    } catch {
      app.log.error({ code: 'RECONCILE_FAILED' }, 'Signing reconciliation failed');
    } finally {
      reconciling = false;
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  app.addHook('onListen', async () => {
    await tick();
    timer = setInterval(() => {
      void tick();
    }, config.ESIGN_RECONCILE_INTERVAL_MS);
    timer.unref();
  });
  app.addHook('onClose', async () => {
    closing = true;
    if (timer) clearInterval(timer);
  });
  app.get('/health/live', async () => ({
    status: 'ok',
    engine: 'documenso',
    version: '2.18.0',
  }));
  app.get('/health/ready', async (_request, reply) => {
    await service.store.query('SELECT 1');
    if (!lastReconcile || Date.now() - lastReconcile > config.ESIGN_RECONCILE_INTERVAL_MS * 4)
      return reply.code(503).send({ status: 'reconciliation-unavailable' });
    return { status: 'ok' };
  });
  app.get('/v1/connections', async (request) => ({
    items: await service.connections(request.principal),
  }));
  app.post('/v1/connections', async (request, reply) =>
    reply.code(201).send(await service.registerConnection(request.principal, request.body)),
  );
  app.post('/v1/connections/:id/revoke', async (request) => {
    const { id } = idParams.parse(request.params),
      { reason } = z.object({ reason: z.string().trim().min(5).max(2000) }).parse(request.body);
    await service.revokeConnection(request.principal, id, reason);
    return { ok: true };
  });
  app.post('/v1/connections/:id/rotate', async (request) =>
    service.rotateConnection(request.principal, idParams.parse(request.params).id, request.body),
  );
  app.get('/v1/connections/:id/webhook-configuration', async (request) => {
    if (!request.principal.admin) throw new BridgeError('ADMIN_REQUIRED', 403);
    const { id } = idParams.parse(request.params);
    await service.connection(id, request.principal.clientId);
    return {
      path: `/webhooks/documenso/${id}`,
      header: 'X-Documenso-Secret',
      secret: webhookSecret(config, id),
    };
  });
  app.get('/v1/connections/:id/templates', async (request) => {
    const { templateId, page } = z
      .object({
        templateId: z.string().min(1).max(200).optional(),
        page: z.coerce.number().int().min(1).max(1000).default(1),
      })
      .parse(request.query);
    return service.templates(
      request.principal,
      idParams.parse(request.params).id,
      templateId,
      page,
    );
  });
  app.post('/v1/connections/:id/templates', async (request, reply) => {
    if (!request.principal.admin) throw new BridgeError('ADMIN_REQUIRED', 403);
    if (!request.isMultipart()) throw new BridgeError('PDF_UPLOAD_REQUIRED', 400);
    const files: FileInput[] = [];
    let payload: unknown;
    let total = 0;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (
          part.fieldname !== 'files' ||
          part.mimetype !== 'application/pdf' ||
          !part.filename.toLowerCase().endsWith('.pdf')
        )
          throw new BridgeError('ONLY_PDF_FILES_ALLOWED', 400);
        const bytes = await part.toBuffer();
        total += bytes.length;
        if (part.file.truncated || total > 100 * 1024 * 1024)
          throw new BridgeError('UPLOAD_TOO_LARGE', 413);
        files.push({
          name: part.filename.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(-180),
          bytes,
        });
      } else if (
        part.fieldname === 'payload' &&
        typeof part.value === 'string' &&
        payload === undefined
      ) {
        payload = JSON.parse(part.value);
      } else throw new BridgeError('INVALID_UPLOAD_FIELD', 400);
    }
    return reply
      .code(201)
      .send(
        await service.uploadTemplate(
          request.principal,
          idParams.parse(request.params).id,
          payload,
          files,
        ),
      );
  });
  app.get('/v1/packages', async (request) => ({
    items: await service.packages(request.principal),
  }));
  app.get('/v1/packages/:id/files', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { partIndex, fileIndex } = z
      .object({
        partIndex: z.coerce.number().int().min(0).max(100),
        fileIndex: z.coerce.number().int().min(0).max(100),
      })
      .strict()
      .parse(request.query);
    const file = await service.packageFile(request.principal, id, partIndex, fileIndex);
    return reply
      .type('application/pdf')
      .header('Content-Disposition', attachmentDisposition(file.name))
      .header('Cache-Control', 'private, no-store')
      .send(file.bytes);
  });
  app.post('/v1/packages', async (request, reply) =>
    reply.code(201).send(await service.publish(request.principal, request.body)),
  );
  app.post('/v1/packages/compose', async (request, reply) =>
    reply.code(201).send(await service.composePackage(request.principal!, request.body)),
  );
  app.post('/v1/packages/:id/retire', async (request) => {
    await service.retirePackage(request.principal, idParams.parse(request.params).id);
    return { ok: true };
  });
  app.post('/v1/packages/preview', async (request) =>
    service.preview(request.principal, request.body),
  );
  app.get('/v1/requests', async (request) =>
    service.list(
      request.principal,
      z
        .object({
          query: z.string().max(200).optional(),
          category: z.enum(['mine', 'draft', 'waiting', 'completed', 'attention']).optional(),
          page: z.coerce.number().int().min(1).max(1000).optional(),
          hr: z
            .enum(['true', 'false'])
            .optional()
            .transform((v) => v === 'true'),
        })
        .parse(request.query),
    ),
  );
  app.post('/v1/requests', async (request, reply) => {
    if (request.isMultipart()) throw new BridgeError('PERSONAL_SIGNING_UNAVAILABLE', 403);
    const input = request.body,
      files: FileInput[] = [];
    return reply.code(201).send(await service.create(request.principal, input, files));
  });
  app.get('/v1/requests/:id', async (request) =>
    service.detail(request.principal, idParams.parse(request.params).id),
  );
  app.get('/v1/requests/:id/review', async (request) =>
    service.review(request.principal, idParams.parse(request.params).id),
  );
  app.get('/v1/requests/:id/reissue', async (request) =>
    service.reissueSeed(request.principal, idParams.parse(request.params).id),
  );
  app.get('/v1/requests/:id/bundle', async (request, reply) => {
    const bundle = await service.bundle(request.principal, idParams.parse(request.params).id);
    return reply
      .type('application/zip')
      .header('Content-Disposition', attachmentDisposition(bundle.name))
      .send(bundle.bytes);
  });
  app.post('/v1/requests/:id/refresh', async (request) =>
    service.refresh(request.principal, idParams.parse(request.params).id),
  );
  app.post('/v1/requests/:id/commands', async (request) => {
    const { action, reason, recipientActor, reviewHash } = z
      .object({
        action: z.enum(['send', 'remind', 'cancel', 'discard', 'close']),
        reason: z.string().trim().min(5).max(2000).optional(),
        recipientActor: z.enum(['owner', 'company']).optional(),
        reviewHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(request.body);
    return service.command(
      request.principal,
      idParams.parse(request.params).id,
      action,
      reason,
      recipientActor,
      reviewHash,
    );
  });
  app.post('/v1/requests/:id/parts/:partId/access', async (request) => {
    const { id, partId } = partParams.parse(request.params),
      { kind, recipientId } = z
        .object({
          kind: z.enum(['editor', 'signer']),
          recipientId: z.number().int().positive().optional(),
        })
        .strict()
        .parse(request.body);
    return service.access(request.principal, id, partId, kind, recipientId);
  });
  app.get('/v1/requests/:id/parts/:partId/files', async (request, reply) => {
    const { id, partId } = partParams.parse(request.params),
      { kind, itemId } = z
        .object({
          kind: z.enum(['original', 'signed', 'audit-log', 'certificate']),
          itemId: z.string().min(1).max(200).optional(),
        })
        .parse(request.query);
    const detail = await service.detail(request.principal, id, false);
    const part = detail.parts.find((p) => p.id === partId);
    const file = part?.document?.files.find((f) => f.id === itemId);
    const name = `${safeFilename(file?.title ?? detail.title)}-${kind}.pdf`;
    return reply
      .type('application/pdf')
      .header('Content-Disposition', attachmentDisposition(name))
      .send(await service.download(request.principal, id, partId, kind, itemId));
  });
  app.post('/webhooks/documenso/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params),
      secret = request.headers['x-documenso-secret'];
    if (typeof secret !== 'string' || !secretEquals(secret, webhookSecret(config, id)))
      throw new BridgeError('INVALID_WEBHOOK_SECRET', 401);
    await service.receiveWebhook(id, request.body);
    return reply.code(202).send({ accepted: true });
  });
  return app;
}
