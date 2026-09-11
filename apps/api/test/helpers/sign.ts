import { createHmac } from 'node:crypto';
import { TEST_WEBHOOK_SECRET } from './test-env.js';

/** The `X-Hub-Signature-256` value GitHub would send for exactly these bytes. */
export function sign(body: string | Buffer, secret = TEST_WEBHOOK_SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}
