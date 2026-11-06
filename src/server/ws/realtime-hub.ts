import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  boxesIntersect,
  clampCoord,
  getObjectBounds,
  isValidFiniteNumber
} from '../../shared/spatial.js';
import type {
  BoundingBox,
  ClientWsMessage,
  ObjectRevisionSummary,
  ServerWsMessage,
  VoidObject
} from '../../shared/types.js';
import type { ServerConfig } from '../config.js';
import {
  ActionRateLimiter,
  hasForbiddenPrototypeKeys
} from '../security/rate-limiter.js';
import {
  DomainError,
  ObjectRepository,
  validateObjectId
} from '../services/object-repository.js';

interface ConnectedClient {
  sessionId: string;
  ip: string;
  socket: WebSocket;
  viewportBounds: BoundingBox;
  watchedObjectId: string | null;
  cursor: { x: number; y: number; updatedAt: number } | null;
}

const DEFAULT_INITIAL_BOUNDS: BoundingBox = {
  minX: -2000,
  minY: -1500,
  maxX: 2000,
  maxY: 1500
};

export class RealtimeHub {
  private clients = new Map<string, ConnectedClient>();
  private connectionsByIp = new Map<string, number>();

  constructor(
    private readonly repo: ObjectRepository,
    private readonly rateLimiter: ActionRateLimiter,
    private readonly config: ServerConfig
  ) {}

  getPresenceCount(): number {
    return this.clients.size;
  }

  canAcceptConnection(ip: string): { allowed: boolean; reason?: string } {
    if (this.clients.size >= this.config.maxTotalWsConnections) {
      return { allowed: false, reason: 'Maximum total server connections reached' };
    }
    const currentForIp = this.connectionsByIp.get(ip) ?? 0;
    if (currentForIp >= this.config.maxWsConnectionsPerIp) {
      return { allowed: false, reason: 'Maximum connections per IP reached' };
    }
    return { allowed: true };
  }

  registerClient(socket: WebSocket, ip: string): string {
    const sessionId = `anon-${crypto.randomBytes(6).toString('hex')}`;
    const client: ConnectedClient = {
      sessionId,
      ip,
      socket,
      viewportBounds: { ...DEFAULT_INITIAL_BOUNDS },
      watchedObjectId: null,
      cursor: null
    };

    this.clients.set(sessionId, client);
    this.connectionsByIp.set(ip, (this.connectionsByIp.get(ip) ?? 0) + 1);

    this.sendToClient(client, {
      type: 'WELCOME',
      sessionId,
      serverTime: new Date().toISOString(),
      presenceCount: this.clients.size
    });

    this.broadcastAll(
      {
        type: 'USER_JOINED',
        sessionId,
        presenceCount: this.clients.size
      },
      sessionId
    );

    socket.on('message', (rawData: Buffer | ArrayBuffer | Buffer[]) => {
      void this.handleMessage(client, rawData);
    });

    socket.on('close', () => {
      this.removeClient(sessionId);
    });

    socket.on('error', () => {
      this.removeClient(sessionId);
    });

    return sessionId;
  }

  private removeClient(sessionId: string): void {
    const client = this.clients.get(sessionId);
    if (!client) return;
    this.clients.delete(sessionId);

    const ipCount = (this.connectionsByIp.get(client.ip) ?? 1) - 1;
    if (ipCount <= 0) {
      this.connectionsByIp.delete(client.ip);
    } else {
      this.connectionsByIp.set(client.ip, ipCount);
    }

    this.broadcastAll({
      type: 'USER_LEFT',
      sessionId,
      presenceCount: this.clients.size
    });
  }

  private sendToClient(client: ConnectedClient, message: ServerWsMessage): void {
    if (client.socket.readyState === 1) {
      try {
        client.socket.send(JSON.stringify(message));
      } catch (_) {}
    }
  }

  private broadcastAll(message: ServerWsMessage, excludeSessionId?: string): void {
    const encoded = JSON.stringify(message);
    for (const [id, client] of this.clients.entries()) {
      if (id === excludeSessionId) continue;
      if (client.socket.readyState === 1) {
        try {
          client.socket.send(encoded);
        } catch (_) {}
      }
    }
  }

  private shouldNotifyClientForObject(
    client: ConnectedClient,
    objBounds: BoundingBox,
    objectId: string,
    prevBounds?: BoundingBox
  ): boolean {
    if (client.watchedObjectId === objectId) return true;
    if (boxesIntersect(client.viewportBounds, objBounds)) return true;
    if (prevBounds && boxesIntersect(client.viewportBounds, prevBounds)) return true;
    return false;
  }

  broadcastObjectCreated(
    object: VoidObject,
    revision: ObjectRevisionSummary,
    clientMutationId?: string,
    requestId?: string
  ): void {
    const objBounds = getObjectBounds(object);
    for (const client of this.clients.values()) {
      if (this.shouldNotifyClientForObject(client, objBounds, object.id)) {
        this.sendToClient(client, {
          type: 'OBJECT_CREATED',
          object,
          clientMutationId,
          requestId
        });
        this.sendToClient(client, {
          type: 'REVISION_CREATED',
          revision
        });
      }
    }
  }

  broadcastObjectUpdated(
    object: VoidObject,
    previousObject: VoidObject,
    revision: ObjectRevisionSummary,
    eventType: 'updated' | 'moved' | 'resized',
    clientMutationId?: string,
    requestId?: string
  ): void {
    const objBounds = getObjectBounds(object);
    const prevBounds = getObjectBounds(previousObject);

    const msgType =
      eventType === 'moved'
        ? 'OBJECT_MOVED'
        : eventType === 'resized'
          ? 'OBJECT_RESIZED'
          : 'OBJECT_UPDATED';

    for (const client of this.clients.values()) {
      if (this.shouldNotifyClientForObject(client, objBounds, object.id, prevBounds)) {
        this.sendToClient(client, {
          type: msgType,
          object,
          clientMutationId,
          requestId
        });
        this.sendToClient(client, {
          type: 'REVISION_CREATED',
          revision
        });
      }
    }
  }

  broadcastObjectDeleted(
    objectId: string,
    revision: number,
    deletedAt: string,
    previousObject: VoidObject,
    revisionSummary: ObjectRevisionSummary,
    clientMutationId?: string,
    requestId?: string
  ): void {
    const prevBounds = getObjectBounds(previousObject);
    for (const client of this.clients.values()) {
      if (this.shouldNotifyClientForObject(client, prevBounds, objectId)) {
        this.sendToClient(client, {
          type: 'OBJECT_DELETED',
          objectId,
          revision,
          deletedAt,
          clientMutationId,
          requestId
        });
        this.sendToClient(client, {
          type: 'REVISION_CREATED',
          revision: revisionSummary
        });
      }
    }
  }

  private async handleMessage(
    client: ConnectedClient,
    rawData: Buffer | ArrayBuffer | Buffer[]
  ): Promise<void> {
    if (!this.rateLimiter.checkWsMessage(client.ip)) {
      this.sendToClient(client, {
        type: 'ERROR',
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'WebSocket message rate limit exceeded'
      });
      return;
    }

    const byteLength = Buffer.isBuffer(rawData)
      ? rawData.byteLength
      : Array.isArray(rawData)
        ? rawData.reduce((acc, b) => acc + b.byteLength, 0)
        : rawData.byteLength;

    if (byteLength > this.config.maxWsMessageBytes) {
      this.sendToClient(client, {
        type: 'ERROR',
        code: 'MESSAGE_TOO_LARGE',
        message: `WebSocket message exceeds ${this.config.maxWsMessageBytes} bytes`
      });
      return;
    }

    let parsed: unknown;
    try {
      const text = Buffer.isBuffer(rawData)
        ? rawData.toString('utf8')
        : Array.isArray(rawData)
          ? Buffer.concat(rawData).toString('utf8')
          : Buffer.from(rawData).toString('utf8');
      parsed = JSON.parse(text);
    } catch {
      this.sendToClient(client, {
        type: 'ERROR',
        code: 'INVALID_JSON',
        message: 'Malformed WebSocket JSON message'
      });
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || hasForbiddenPrototypeKeys(parsed)) {
      this.sendToClient(client, {
        type: 'ERROR',
        code: 'INVALID_MESSAGE',
        message: 'Invalid WebSocket message object'
      });
      return;
    }

    const msg = parsed as ClientWsMessage;
    try {
      switch (msg.type) {
        case 'PING': {
          this.sendToClient(client, {
            type: 'PONG',
            timestamp: isValidFiniteNumber(msg.timestamp) ? msg.timestamp : Date.now(),
            serverTime: new Date().toISOString()
          });
          break;
        }

        case 'SUBSCRIBE_VIEWPORT': {
          if (
            !msg.bounds ||
            !isValidFiniteNumber(msg.bounds.minX) ||
            !isValidFiniteNumber(msg.bounds.maxX) ||
            !isValidFiniteNumber(msg.bounds.minY) ||
            !isValidFiniteNumber(msg.bounds.maxY)
          ) {
            throw new DomainError(400, 'INVALID_BOUNDS', 'Viewport bounds must contain finite minX, minY, maxX, maxY');
          }
          const bounds: BoundingBox = {
            minX: clampCoord(Math.min(msg.bounds.minX, msg.bounds.maxX)),
            maxX: clampCoord(Math.max(msg.bounds.minX, msg.bounds.maxX)),
            minY: clampCoord(Math.min(msg.bounds.minY, msg.bounds.maxY)),
            maxY: clampCoord(Math.max(msg.bounds.minY, msg.bounds.maxY))
          };
          client.viewportBounds = bounds;
          const objects = await this.repo.getRegionObjects(bounds);
          this.sendToClient(client, {
            type: 'VIEWPORT_SNAPSHOT',
            bounds,
            objects
          });
          break;
        }

        case 'WATCH_OBJECT': {
          if (msg.objectId === null) {
            client.watchedObjectId = null;
          } else {
            client.watchedObjectId = validateObjectId(msg.objectId);
          }
          break;
        }

        case 'CURSOR_MOVE': {
          if (!isValidFiniteNumber(msg.x) || !isValidFiniteNumber(msg.y)) {
            return;
          }
          const x = clampCoord(msg.x);
          const y = clampCoord(msg.y);
          const now = Date.now();
          client.cursor = { x, y, updatedAt: now };
          const cursorBox: BoundingBox = { minX: x, minY: y, maxX: x, maxY: y };
          for (const other of this.clients.values()) {
            if (other.sessionId === client.sessionId) continue;
            if (boxesIntersect(other.viewportBounds, cursorBox)) {
              this.sendToClient(other, {
                type: 'CURSOR_MOVED',
                cursor: {
                  sessionId: client.sessionId,
                  x,
                  y,
                  updatedAt: now
                }
              });
            }
          }
          break;
        }

        case 'CREATE_OBJECT': {
          if (!msg.payload || typeof msg.payload !== 'object') {
            throw new DomainError(400, 'INVALID_PAYLOAD', 'Missing CREATE_OBJECT payload');
          }
          this.rateLimiter.checkCreate(client.ip);
          const created = await this.repo.createObject(msg.payload);
          this.broadcastObjectCreated(
            created.object,
            created.revision,
            msg.payload.clientMutationId,
            msg.requestId
          );
          break;
        }

        case 'UPDATE_OBJECT': {
          if (!msg.payload || typeof msg.payload !== 'object') {
            throw new DomainError(400, 'INVALID_PAYLOAD', 'Missing UPDATE_OBJECT payload');
          }
          this.rateLimiter.checkMutation(client.ip);
          const updated = await this.repo.updateObject(msg.objectId, msg.payload);
          this.broadcastObjectUpdated(
            updated.object,
            updated.previousObject,
            updated.revision,
            updated.eventType,
            msg.payload.clientMutationId,
            msg.requestId
          );
          break;
        }

        case 'DELETE_OBJECT': {
          this.rateLimiter.checkDelete(client.ip);
          const deleted = await this.repo.deleteObject(msg.objectId);
          this.broadcastObjectDeleted(
            deleted.objectId,
            deleted.revision,
            deleted.deletedAt,
            deleted.previousObject,
            deleted.revisionSummary,
            msg.clientMutationId,
            msg.requestId
          );
          break;
        }

        default: {
          this.sendToClient(client, {
            type: 'ERROR',
            code: 'UNKNOWN_MESSAGE_TYPE',
            message: 'Unsupported WebSocket message type'
          });
        }
      }
    } catch (err) {
      if (err instanceof DomainError) {
        this.sendToClient(client, {
          type: 'ERROR',
          code: err.code,
          message: err.message,
          requestId: 'requestId' in msg ? msg.requestId : undefined
        });
      } else {
        this.sendToClient(client, {
          type: 'ERROR',
          code: 'INTERNAL_ERROR',
          message: 'Failed to process WebSocket message',
          requestId: 'requestId' in msg ? msg.requestId : undefined
        });
      }
    }
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.socket.close();
      } catch (_) {}
    }
    this.clients.clear();
    this.connectionsByIp.clear();
  }
}
