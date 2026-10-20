// Reads JSON arguments on stdin, prints a JSON result on stdout.
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const args = JSON.parse(input || '{}');
  if (args.word === 'boom') { process.stderr.write('it exploded'); process.exit(3); }
  process.stdout.write(JSON.stringify({ word: String(args.word ?? '').toUpperCase(), key: process.env.MEMWISE_IDEMPOTENCY_KEY ?? null }) + '\n');
});
