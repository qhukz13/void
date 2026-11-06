import type { FastifyInstance } from 'fastify';
import { isValidFiniteNumber } from '../../shared/spatial.js';
import type { CreateObjectInput, UpdateObjectInput } from '../../shared/types.js';
import type { ServerConfig } from '../config.js';
import type { DatabaseAdapter } from '../db/adapter.js';
import { ActionRateLimiter, hasForbiddenPrototypeKeys } from '../security/rate-limiter.js';
import { DomainError, ObjectRepository } from '../services/object-repository.js';
import type { RealtimeHub } from '../ws/realtime-hub.js';

export async function registerApiRoutes(
  app: FastifyInstance,
  deps: {
    db: DatabaseAdapter;
    repo: ObjectRepository;
    hub: RealtimeHub;
    rateLimiter: ActionRateLimiter;
    config: ServerConfig;
  }
): Promise<void> {
  const { db, repo, hub, rateLimiter } = deps;

  // Reject prototype pollution keys on all JSON request bodies
  app.addHook('preValidation', async (request) => {
    if (request.body && typeof request.body === 'object') {
      if (Array.isArray(request.body) || hasForbiddenPrototypeKeys(request.body)) {
        throw new DomainError(400, 'INVALID_PAYLOAD', 'Request body contains forbidden or malformed properties');
      }
    }
  });

  app.get('/api/health', async () => {
    const activeObjects = await repo.getActiveObjectCount();
    return {
      status: 'ok',
      engine: db.engineType,
      activeObjects,
      connectedClients: hub.getPresenceCount(),
      uptimeSec: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    };
  });

  app.get<{
    Querystring: {
      minX?: string;
      minY?: string;
      maxX?: string;
      maxY?: string;
      limit?: string;
    };
  }>('/api/region', async (request) => {
    const minX = Number(request.query.minX ?? -2000);
    const minY = Number(request.query.minY ?? -1500);
    const maxX = Number(request.query.maxX ?? 2000);
    const maxY = Number(request.query.maxY ?? 1500);
    const limit = request.query.limit !== undefined ? Number(request.query.limit) : undefined;

    if (!isValidFiniteNumber(minX) || !isValidFiniteNumber(minY) || !isValidFiniteNumber(maxX) || !isValidFiniteNumber(maxY)) {
      throw new DomainError(400, 'INVALID_BOUNDS', 'Query parameters minX, minY, maxX, maxY must be finite numbers');
    }

    const objects = await repo.getRegionObjects({ minX, minY, maxX, maxY }, limit);
    return { objects };
  });

  app.get<{
    Params: { id: string };
    Querystring: { includeDeleted?: string };
  }>('/api/objects/:id', async (request) => {
    const includeDeleted = request.query.includeDeleted === 'true';
    const obj = await repo.getObjectById(request.params.id, includeDeleted);
    if (!obj) {
      throw new DomainError(404, 'OBJECT_NOT_FOUND', 'Object not found');
    }
    return { object: obj };
  });

  app.post<{
    Body: CreateObjectInput;
  }>('/api/objects', async (request, reply) => {
    if (!request.body || typeof request.body !== 'object') {
      throw new DomainError(400, 'INVALID_PAYLOAD', 'Request body must be a JSON object');
    }
    rateLimiter.checkCreate(request.ip);

    const created = await repo.createObject(request.body);
    hub.broadcastObjectCreated(
      created.object,
      created.revision,
      request.body.clientMutationId
    );

    reply.code(201);
    return {
      object: created.object,
      revision: created.revision
    };
  });

  app.patch<{
    Params: { id: string };
    Body: UpdateObjectInput;
  }>('/api/objects/:id', async (request) => {
    if (!request.body || typeof request.body !== 'object') {
      throw new DomainError(400, 'INVALID_PAYLOAD', 'Request body must be a JSON object');
    }
    rateLimiter.checkMutation(request.ip);

    const updated = await repo.updateObject(request.params.id, request.body);
    hub.broadcastObjectUpdated(
      updated.object,
      updated.previousObject,
      updated.revision,
      updated.eventType,
      request.body.clientMutationId
    );

    return {
      object: updated.object,
      revision: updated.revision
    };
  });

  app.delete<{
    Params: { id: string };
    Querystring: { clientMutationId?: string };
  }>('/api/objects/:id', async (request) => {
    rateLimiter.checkDelete(request.ip);

    const deleted = await repo.deleteObject(request.params.id);
    hub.broadcastObjectDeleted(
      deleted.objectId,
      deleted.revision,
      deleted.deletedAt,
      deleted.previousObject,
      deleted.revisionSummary,
      request.query.clientMutationId
    );

    return {
      objectId: deleted.objectId,
      revision: deleted.revision,
      deletedAt: deleted.deletedAt
    };
  });

  app.get<{
    Params: { id: string };
  }>('/api/objects/:id/revisions', async (request) => {
    const result = await repo.getObjectRevisions(request.params.id);
    return {
      object: {
        id: result.object.id,
        revision: result.object.revision,
        deleted: result.object.deleted,
        deletedAt: result.object.deletedAt,
        createdAt: result.object.createdAt,
        updatedAt: result.object.updatedAt
      },
      revisions: result.revisions
    };
  });

  app.get<{
    Params: { id: string; revision: string };
  }>('/api/objects/:id/revisions/:revision', async (request) => {
    const revNum = Number.parseInt(request.params.revision, 10);
    if (!Number.isInteger(revNum) || revNum < 1 || String(revNum) !== request.params.revision.trim()) {
      throw new DomainError(400, 'INVALID_REVISION', 'Revision parameter must be a positive integer');
    }
    const detail = await repo.getObjectRevisionDetail(request.params.id, revNum);
    return { revision: detail };
  });

  // Explicitly forbid any attempt to restore/revert/rollback objects
  const forbidRestoration = async () => {
    throw new DomainError(
      403,
      'RESTORATION_FORBIDDEN',
      'History is archaeology, not a safety net. Automatic restoration or rollback is prohibited.'
    );
  };
  app.post('/api/objects/:id/restore', forbidRestoration);
  app.post('/api/objects/:id/revert', forbidRestoration);
  app.post('/api/objects/:id/rollback', forbidRestoration);
}
