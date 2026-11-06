import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { loadConfig, type ServerConfig } from './config.js';
import { createDatabaseAdapter, type DatabaseAdapter } from './db/adapter.js';
import { runMigrations } from './db/migrations.js';
import { registerApiRoutes } from './routes/api.js';
import { ActionRateLimiter, isOriginAllowed } from './security/rate-limiter.js';
import { DomainError, ObjectRepository } from './services/object-repository.js';
import { RealtimeHub } from './ws/realtime-hub.js';

export interface VoidAppContext {
  app: FastifyInstance;
  db: DatabaseAdapter;
  repo: ObjectRepository;
  hub: RealtimeHub;
  rateLimiter: ActionRateLimiter;
  config: ServerConfig;
}

export async function createApp(overrides: Partial<ServerConfig> = {}): Promise<VoidAppContext> {
  const config = loadConfig(overrides);

  const app = Fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : {
            level: config.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie']
          },
    bodyLimit: config.maxPayloadBytes,
    trustProxy: true
  });

  const db = await createDatabaseAdapter(config);
  await runMigrations(db);

  const repo = new ObjectRepository(db, config);
  await repo.seedInitialObjectIfEmpty();

  const rateLimiter = new ActionRateLimiter(config);
  const hub = new RealtimeHub(repo, rateLimiter, config);

  // Global error handler must be registered before plugins and routes in Fastify v5
  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _request, reply) => {
    if (err instanceof DomainError) {
      reply.code(err.statusCode).send({
        code: err.code,
        error: {
          code: err.code,
          message: err.message
        }
      });
      return;
    }

    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.statusCode === 413) {
      reply.code(413).send({
        code: 'PAYLOAD_TOO_LARGE',
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request payload exceeds maximum allowed size'
        }
      });
      return;
    }

    if (err instanceof SyntaxError || err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err.statusCode === 400) {
      reply.code(400).send({
        code: 'BAD_REQUEST',
        error: {
          code: 'BAD_REQUEST',
          message: err.message || 'Malformed request'
        }
      });
      return;
    }

    if (err.statusCode === 429) {
      reply.code(429).send({
        code: 'RATE_LIMIT_EXCEEDED',
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: err.message || 'Rate limit exceeded'
        }
      });
      return;
    }

    app.log.error(err);
    reply.code(500).send({
      code: 'INTERNAL_SERVER_ERROR',
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal error occurred'
      }
    });
  });

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        frameSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"]
      }
    },
    crossOriginEmbedderPolicy: false
  });

  // CORS for HTTP endpoints (WebSocket origin validation is handled directly on /ws)
  await app.register(cors, {
    origin: (origin, cb) => {
      if (isOriginAllowed(origin, undefined, config.allowedOrigins)) {
        cb(null, true);
      } else {
        cb(null, false);
      }
    }
  });

  // HTTP Rate limiting
  await app.register(rateLimit, {
    max: config.rateLimitHttpMax,
    timeWindow: config.rateLimitHttpWindowMs,
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      code: 'RATE_LIMIT_EXCEEDED',
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: `HTTP rate limit exceeded, retry in ${context.after}`
      }
    })
  });

  // WebSocket support
  await app.register(websocket, {
    options: {
      maxPayload: config.maxWsMessageBytes
    }
  });

  // Register WebSocket endpoint
  app.get('/ws', { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    const host = req.headers.host;

    if (!isOriginAllowed(origin, host, config.allowedOrigins)) {
      try {
        socket.send(
          JSON.stringify({
            type: 'ERROR',
            code: 'FORBIDDEN_ORIGIN',
            message: 'WebSocket origin is not allowed'
          })
        );
      } catch (_) {}
      socket.close(1008, 'Forbidden origin');
      return;
    }

    const admission = hub.canAcceptConnection(req.ip);
    if (!admission.allowed) {
      try {
        socket.send(
          JSON.stringify({
            type: 'ERROR',
            code: 'CONNECTION_LIMIT_EXCEEDED',
            message: admission.reason || 'Connection limit exceeded'
          })
        );
      } catch (_) {}
      socket.close(1013, 'Try again later');
      return;
    }

    hub.registerClient(socket, req.ip);
  });

  // Register API routes
  await registerApiRoutes(app, {
    db,
    repo,
    hub,
    rateLimiter,
    config
  });

  // Serve built static frontend in production when dist/client exists
  const clientDistDir = path.resolve(process.cwd(), 'dist/client');
  if (fs.existsSync(clientDistDir)) {
    await app.register(fastifyStatic, {
      root: clientDistDir,
      prefix: '/',
      wildcard: false
    });

    app.setNotFoundHandler(async (request, reply) => {
      const pathname = request.url.split('?')[0];
      if (request.method === 'GET' && pathname === '/') {
        return reply.sendFile('index.html');
      }
      reply.code(404).send({
        code: 'NOT_FOUND',
        error: {
          code: 'NOT_FOUND',
          message: `Endpoint ${request.method} ${pathname} not found`
        }
      });
    });
  } else {
    app.setNotFoundHandler(async (request, reply) => {
      const pathname = request.url.split('?')[0];
      reply.code(404).send({
        code: 'NOT_FOUND',
        error: {
          code: 'NOT_FOUND',
          message: `Endpoint ${request.method} ${pathname} not found`
        }
      });
    });
  }

  app.addHook('onClose', async () => {
    hub.closeAll();
    rateLimiter.destroy();
    if (typeof app.server?.closeAllConnections === 'function') {
      app.server.closeAllConnections();
    }
    await db.close();
  });

  return {
    app,
    db,
    repo,
    hub,
    rateLimiter,
    config
  };
}
