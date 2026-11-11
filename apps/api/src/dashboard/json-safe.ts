import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { map, type Observable } from 'rxjs';

/**
 * Makes a response JSON-safe, in one place: `BigInt` becomes a string and a `Date` its ISO
 * string. `JSON.stringify` throws on a BigInt, and GitHub's IDs are BigInts in Prisma — so a
 * dashboard response built from rows would otherwise be a 500. As strings, IDs above 2^53
 * also survive a JavaScript client, which a JSON number would not.
 */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, jsonSafe(v)]),
    );
  }
  return value;
}

@Injectable()
export class JsonSafeInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    return next.handle().pipe(map(jsonSafe));
  }
}
