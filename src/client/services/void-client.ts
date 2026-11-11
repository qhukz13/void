import type {
  BoundingBox,
  ClientWsMessage,
  CreateObjectInput,
  ObjectRevisionDetail,
  ObjectRevisionSummary,
  ServerWsMessage,
  UpdateObjectInput,
  VoidObject,
  WorldSignalBeacon
} from '../../shared/types.js';

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'offline';

export class VoidApiClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private currentBounds: BoundingBox = {
    minX: -2000,
    minY: -1500,
    maxX: 2000,
    maxY: 1500
  };
  private watchedObjectId: string | null = null;

  constructor(
    private readonly onServerMessage: (msg: ServerWsMessage) => void,
    private readonly onConnectionStateChange: (state: ConnectionState) => void
  ) {}

  connect(): void {
    this.manuallyClosed = false;
    this.openSocket();
  }

  private openSocket(): void {
    if (this.manuallyClosed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.onConnectionStateChange(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const socket = new WebSocket(wsUrl);
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.onConnectionStateChange('online');
      this.send({
        type: 'SUBSCRIBE_VIEWPORT',
        bounds: this.currentBounds
      });
      if (this.watchedObjectId) {
        this.send({
          type: 'WATCH_OBJECT',
          objectId: this.watchedObjectId
        });
      }
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as ServerWsMessage;
        this.onServerMessage(msg);
      } catch (_) {}
    };

    socket.onclose = () => {
      this.ws = null;
      if (!this.manuallyClosed) {
        this.scheduleReconnect();
      } else {
        this.onConnectionStateChange('offline');
      }
    };

    socket.onerror = () => {
      // onclose will handle reconnection
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectAttempt += 1;
    this.onConnectionStateChange('reconnecting');
    const delay = Math.min(4000, 250 * Math.pow(1.5, Math.min(6, this.reconnectAttempt)));
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  send(msg: ClientWsMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  subscribeViewport(bounds: BoundingBox): void {
    this.currentBounds = bounds;
    this.send({
      type: 'SUBSCRIBE_VIEWPORT',
      bounds
    });
  }

  watchObject(objectId: string | null): void {
    this.watchedObjectId = objectId;
    this.send({
      type: 'WATCH_OBJECT',
      objectId
    });
  }

  sendCursorMove(x: number, y: number): void {
    this.send({
      type: 'CURSOR_MOVE',
      x,
      y
    });
  }

  disconnect(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // Authoritative HTTP REST methods
  async fetchRegion(bounds: BoundingBox): Promise<VoidObject[]> {
    const params = new URLSearchParams({
      minX: String(Math.floor(bounds.minX)),
      minY: String(Math.floor(bounds.minY)),
      maxX: String(Math.ceil(bounds.maxX)),
      maxY: String(Math.ceil(bounds.maxY))
    });
    const res = await fetch(`/api/region?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Failed to load region (${res.status})`);
    }
    const data = (await res.json()) as { objects: VoidObject[] };
    return data.objects;
  }

  async fetchWorldSignals(): Promise<{
    signals: WorldSignalBeacon[];
    totalActiveObjects: number;
    activeSectors: number;
  }> {
    const res = await fetch('/api/signals?limit=200');
    if (!res.ok) {
      throw new Error(`Failed to load world signals (${res.status})`);
    }
    return (await res.json()) as {
      signals: WorldSignalBeacon[];
      totalActiveObjects: number;
      activeSectors: number;
    };
  }

  async fetchObject(id: string, includeDeleted = false): Promise<VoidObject | null> {
    const res = await fetch(`/api/objects/${encodeURIComponent(id)}?includeDeleted=${includeDeleted}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Failed to fetch object (${res.status})`);
    }
    const data = (await res.json()) as { object: VoidObject };
    return data.object;
  }

  async createObject(input: CreateObjectInput): Promise<{ object: VoidObject; revision: ObjectRevisionSummary }> {
    const res = await fetch('/api/objects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || `Failed to create object (${res.status})`);
    }
    return data as { object: VoidObject; revision: ObjectRevisionSummary };
  }

  async updateObject(
    id: string,
    input: UpdateObjectInput
  ): Promise<{ object: VoidObject; revision: ObjectRevisionSummary }> {
    const res = await fetch(`/api/objects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || `Failed to update object (${res.status})`);
    }
    return data as { object: VoidObject; revision: ObjectRevisionSummary };
  }

  async deleteObject(
    id: string,
    clientMutationId?: string
  ): Promise<{ objectId: string; revision: number; deletedAt: string }> {
    const query = clientMutationId ? `?clientMutationId=${encodeURIComponent(clientMutationId)}` : '';
    const res = await fetch(`/api/objects/${encodeURIComponent(id)}${query}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || `Failed to delete object (${res.status})`);
    }
    return data as { objectId: string; revision: number; deletedAt: string };
  }

  async fetchRevisions(id: string): Promise<{
    object: Pick<VoidObject, 'id' | 'revision' | 'deleted' | 'deletedAt' | 'createdAt' | 'updatedAt'>;
    revisions: ObjectRevisionSummary[];
  }> {
    const res = await fetch(`/api/objects/${encodeURIComponent(id)}/revisions`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || `Failed to fetch revisions (${res.status})`);
    }
    return data;
  }

  async fetchRevisionDetail(id: string, revision: number): Promise<ObjectRevisionDetail> {
    const res = await fetch(`/api/objects/${encodeURIComponent(id)}/revisions/${revision}`);
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message || `Failed to fetch revision #${revision} (${res.status})`);
    }
    return data.revision as ObjectRevisionDetail;
  }
}
