export type RevisionEventType =
  | 'created'
  | 'updated'
  | 'moved'
  | 'resized'
  | 'deleted';

export interface VoidObject {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  html: string;
  css: string;
  javascript: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  deleted: boolean;
  deletedAt: string | null;
}

export interface ObjectRevisionSummary {
  id: number;
  objectId: string;
  revision: number;
  eventType: RevisionEventType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  htmlBytes: number;
  cssBytes: number;
  jsBytes: number;
  createdAt: string;
}

export interface ObjectRevisionDetail extends ObjectRevisionSummary {
  html: string;
  css: string;
  javascript: string;
}

export interface BoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface CreateObjectInput {
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  zIndex?: number;
  html?: string;
  css?: string;
  javascript?: string;
  clientMutationId?: string;
}

export interface UpdateObjectInput {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  zIndex?: number;
  html?: string;
  css?: string;
  javascript?: string;
  expectedRevision?: number;
  clientMutationId?: string;
}

export interface AnonymousCursor {
  sessionId: string;
  x: number;
  y: number;
  updatedAt: number;
}

export interface WorldSignalBeacon {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  chunkX: number;
  chunkY: number;
  revision: number;
  updatedAt: string;
}

export interface SandboxDiagnostic {
  objectId: string;
  revision: number;
  type: 'syntax_error' | 'runtime_error' | 'timeout_error' | 'dom_limit' | 'resource_limit' | 'console_error' | 'console_log';
  message: string;
  line?: number;
  column?: number;
  timestamp: number;
}

// WebSocket Client -> Server messages
export type ClientWsMessage =
  | {
      type: 'SUBSCRIBE_VIEWPORT';
      bounds: BoundingBox;
      zoom?: number;
    }
  | {
      type: 'WATCH_OBJECT';
      objectId: string | null;
    }
  | {
      type: 'CURSOR_MOVE';
      x: number;
      y: number;
    }
  | {
      type: 'CREATE_OBJECT';
      payload: CreateObjectInput;
      requestId?: string;
    }
  | {
      type: 'UPDATE_OBJECT';
      objectId: string;
      payload: UpdateObjectInput;
      requestId?: string;
    }
  | {
      type: 'DELETE_OBJECT';
      objectId: string;
      clientMutationId?: string;
      requestId?: string;
    }
  | {
      type: 'PING';
      timestamp: number;
    };

// WebSocket Server -> Client messages
export type ServerWsMessage =
  | {
      type: 'WELCOME';
      sessionId: string;
      serverTime: string;
      presenceCount: number;
    }
  | {
      type: 'VIEWPORT_SNAPSHOT';
      bounds: BoundingBox;
      objects: VoidObject[];
    }
  | {
      type: 'OBJECT_CREATED';
      object: VoidObject;
      clientMutationId?: string;
      requestId?: string;
    }
  | {
      type: 'OBJECT_UPDATED';
      object: VoidObject;
      clientMutationId?: string;
      requestId?: string;
    }
  | {
      type: 'OBJECT_MOVED';
      object: VoidObject;
      clientMutationId?: string;
      requestId?: string;
    }
  | {
      type: 'OBJECT_RESIZED';
      object: VoidObject;
      clientMutationId?: string;
      requestId?: string;
    }
  | {
      type: 'OBJECT_DELETED';
      objectId: string;
      revision: number;
      deletedAt: string;
      clientMutationId?: string;
      requestId?: string;
    }
  | {
      type: 'REVISION_CREATED';
      revision: ObjectRevisionSummary;
    }
  | {
      type: 'USER_JOINED';
      sessionId: string;
      presenceCount: number;
    }
  | {
      type: 'USER_LEFT';
      sessionId: string;
      presenceCount: number;
    }
  | {
      type: 'CURSOR_MOVED';
      cursor: AnonymousCursor;
    }
  | {
      type: 'PONG';
      timestamp: number;
      serverTime: string;
    }
  | {
      type: 'ERROR';
      code: string;
      message: string;
      requestId?: string;
    };
