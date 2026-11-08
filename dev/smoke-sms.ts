/**
 * Vynfy SMS smoke test through the SANDBOX endpoint (never delivered, never
 * charged). Run: npx tsx --env-file=.env.local dev/smoke-sms.ts
 * Prints only status information, never the API key.
 */
import { VynfyProvider } from '../server/sms/provider.js';

const key = process.env.VYNFY_API_KEY ?? '';
const sender = process.env.VYNFY_SENDER_ID ?? '';
if (!key || !sender) throw new Error('VYNFY_API_KEY and VYNFY_SENDER_ID are required');

const balance = async () =>
  ((await (await fetch('https://sms.vynfy.com/api/v1/check/balance', { headers: { 'x-api-key': key } })).json()) as { sms_balance?: string }).sms_balance;

const before = await balance();
const sms = new VynfyProvider(key, sender, true);
const ok = await sms.send('+233552148347', 'Your Atlas AI verification code is 123456. It expires in 5 minutes. Do not share it.');
console.log('sandbox send ok, task id present:', Boolean(ok.id));
try {
  await sms.send('+233000000000', 'test');
  console.log('UNEXPECTED: invalid number accepted');
} catch (err) {
  console.log('invalid number rejected as:', (err as { code?: string }).code);
}
const after = await balance();
console.log('balance unchanged:', before === after, `(${before})`);
