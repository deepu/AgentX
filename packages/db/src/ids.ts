// ULIDs without a dependency (same scheme as @memwise/runtime ids.ts): 48-bit time and 80
// random bits in Crockford base32, so ids sort by creation time.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let time = '';
  for (let i = 0, n = now; i < 10; i++, n = Math.floor(n / 32)) time = CROCKFORD[n % 32] + time;
  let rand = '';
  for (const b of crypto.getRandomValues(new Uint8Array(16))) rand += CROCKFORD[b & 31];
  return time + rand;
}
