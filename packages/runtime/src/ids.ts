// Ids (18-kernel-interfaces.md "Conventions"). ULIDs without a dependency: 48-bit time and
// 80 random bits in Crockford base32, so ids sort by creation time.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()): string {
  let time = '';
  for (let i = 0, n = now; i < 10; i++, n = Math.floor(n / 32)) time = CROCKFORD[n % 32] + time;
  let rand = '';
  for (const b of crypto.getRandomValues(new Uint8Array(16))) rand += CROCKFORD[b & 31];
  return time + rand;
}

export const newRunId = () => `run_${ulid()}`;
export const newCaseId = () => `case_${ulid()}`;
/** Also the step's DBOS workflow id (D39). */
export const stepRunIdOf = (runId: string, enteredSeq: number, state: string) => `${runId}/${enteredSeq}/${state}`;
/** The run driver's DBOS workflow id; fixed, so starting a run twice is harmless. */
export const driverIdOf = (runId: string) => `run:${runId}`;
