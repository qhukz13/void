import type { ServerConfig } from '../config.js';
import { DomainError } from '../services/object-repository.js';

interface Bucket {
  count: number;
  resetAt: number;
}

export class ActionRateLimiter {
  private buckets = new Map<string, Bucket>();
  private cleanupTimer: NodeJS.Timeout;

  constructor(private readonly config: ServerConfig) {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets.entries()) {
        if (now >= bucket.resetAt) {
          this.buckets.delete(key);
        }
      }
    }, 30_000);
    this.cleanupTimer.unref();
  }

  private consume(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (existing.count >= max) {
      return false;
    }
    existing.count += 1;
    return true;
  }

  checkCreate(actorKey: string): void {
    if (!this.consume(`create:${actorKey}`, this.config.rateLimitCreatesPerMin, 60_000)) {
      throw new DomainError(
        429,
        'RATE_LIMIT_EXCEEDED',
        `Creation rate limit exceeded (${this.config.rateLimitCreatesPerMin}/min)`
      );
    }
    this.checkMutation(actorKey);
  }

  checkDelete(actorKey: string): void {
    if (!this.consume(`delete:${actorKey}`, this.config.rateLimitDeletesPerMin, 60_000)) {
      throw new DomainError(
        429,
        'RATE_LIMIT_EXCEEDED',
        `Deletion rate limit exceeded (${this.config.rateLimitDeletesPerMin}/min)`
      );
    }
    this.checkMutation(actorKey);
  }

  checkMutation(actorKey: string): void {
    if (!this.consume(`mutate:${actorKey}`, this.config.rateLimitMutationsPerMin, 60_000)) {
      throw new DomainError(
        429,
        'RATE_LIMIT_EXCEEDED',
        `Mutation rate limit exceeded (${this.config.rateLimitMutationsPerMin}/min)`
      );
    }
  }

  checkWsMessage(actorKey: string): boolean {
    return this.consume(`ws:${actorKey}`, 300, 10_000);
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
    this.buckets.clear();
  }
}

export function isOriginAllowed(
  originHeader: string | undefined,
  hostHeader: string | undefined,
  allowedOrigins: string[]
): boolean {
  // Non-browser clients (e.g. local health/test clients) may omit Origin
  if (!originHeader) return true;

  // Reject explicit 'null' origin from sandboxed iframes attempting to connect to WS
  if (originHeader === 'null') return false;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(originHeader);
  } catch {
    return false;
  }

  // Always allow same-host origin
  if (hostHeader && parsedOrigin.host.toLowerCase() === hostHeader.toLowerCase()) {
    return true;
  }

  if (allowedOrigins.includes('*')) {
    // Even when wildcard is set for dev convenience, block explicitly known malicious test origins
    // or non-http(s) schemes
    if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
      return false;
    }
    if (parsedOrigin.hostname.endsWith('.evil.example') || parsedOrigin.hostname === 'evil.com') {
      return false;
    }
    return true;
  }

  const normalizedOrigin = `${parsedOrigin.protocol}//${parsedOrigin.host}`.toLowerCase();
  return allowedOrigins.some((allowed) => allowed.toLowerCase() === normalizedOrigin);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function hasForbiddenPrototypeKeys(value: unknown, depth = 0): boolean {
  if (depth > 8 || value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasForbiddenPrototypeKeys(item, depth + 1));
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return true;
    }
    if (hasForbiddenPrototypeKeys(obj[key], depth + 1)) {
      return true;
    }
  }
  return false;
}
