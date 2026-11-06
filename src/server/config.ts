import dotenv from 'dotenv';
import {
  DEFAULT_MAX_CSS_BYTES,
  DEFAULT_MAX_HTML_BYTES,
  DEFAULT_MAX_JS_BYTES
} from '../shared/constants.js';

dotenv.config();

export interface ServerConfig {
  port: number;
  host: string;
  nodeEnv: string;
  logLevel: string;
  databaseUrl?: string;
  pgliteDataDir: string;
  seedInitialObject: boolean;
  allowedOrigins: string[];
  maxHtmlBytes: number;
  maxCssBytes: number;
  maxJsBytes: number;
  maxPayloadBytes: number;
  maxWsMessageBytes: number;
  maxObjectsPerRegionQuery: number;
  maxRevisionsPerObject: number;
  rateLimitHttpMax: number;
  rateLimitHttpWindowMs: number;
  rateLimitMutationsPerMin: number;
  rateLimitCreatesPerMin: number;
  rateLimitDeletesPerMin: number;
  maxWsConnectionsPerIp: number;
  maxTotalWsConnections: number;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const rawOrigins = process.env.ALLOWED_ORIGINS ?? '*';
  const allowedOrigins = rawOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    port: envInt('PORT', 3000),
    host: process.env.HOST || '0.0.0.0',
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
    pgliteDataDir: process.env.PGLITE_DATA_DIR?.trim() || './data/pgdata',
    seedInitialObject: process.env.SEED_INITIAL_OBJECT !== 'false',
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ['*'],
    maxHtmlBytes: envInt('MAX_HTML_BYTES', DEFAULT_MAX_HTML_BYTES),
    maxCssBytes: envInt('MAX_CSS_BYTES', DEFAULT_MAX_CSS_BYTES),
    maxJsBytes: envInt('MAX_JS_BYTES', DEFAULT_MAX_JS_BYTES),
    maxPayloadBytes: envInt('MAX_PAYLOAD_BYTES', 262144),
    maxWsMessageBytes: envInt('MAX_WS_MESSAGE_BYTES', 262144),
    maxObjectsPerRegionQuery: envInt('MAX_OBJECTS_PER_REGION_QUERY', 250),
    maxRevisionsPerObject: envInt('MAX_REVISIONS_PER_OBJECT', 100),
    rateLimitHttpMax: envInt('RATE_LIMIT_HTTP_MAX', 600),
    rateLimitHttpWindowMs: envInt('RATE_LIMIT_HTTP_WINDOW_MS', 60000),
    rateLimitMutationsPerMin: envInt('RATE_LIMIT_MUTATIONS_PER_MIN', 120),
    rateLimitCreatesPerMin: envInt('RATE_LIMIT_CREATES_PER_MIN', 40),
    rateLimitDeletesPerMin: envInt('RATE_LIMIT_DELETES_PER_MIN', 60),
    maxWsConnectionsPerIp: envInt('MAX_WS_CONNECTIONS_PER_IP', 50),
    maxTotalWsConnections: envInt('MAX_TOTAL_WS_CONNECTIONS', 2000),
    ...overrides
  };
}
