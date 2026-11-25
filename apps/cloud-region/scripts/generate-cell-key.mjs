// Prints a new Ed25519 private key for CELL_PRIVATE_KEY: a JSON Web Key on one line, the form
// the cell reads. Put it in apps/cloud-region/.env, and nowhere else: anyone who has it can ask
// cloud-global for GitHub tokens as this cell. It is the cell's own key, never its
// PASS_PRIVATE_KEY nor cloud-global's CELL_TOKEN_PRIVATE_KEY.
//
// Its public half, printed after it (on standard error, so `> file` keeps the key alone), goes in
// cloud-global's .env as CELL_PUBLIC_KEY_<REGION> for this cell's region.
//
//   pnpm --filter @consola/cloud-region cell-key:generate
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ed25519');
const { kty, crv, x, d } = privateKey.export({ format: 'jwk' });
process.stdout.write(`${JSON.stringify({ crv, d, x, kty })}\n`);
process.stderr.write(
  `Its public half, for cloud-global's CELL_PUBLIC_KEY_<REGION>:\n${JSON.stringify({ crv, x, kty })}\n`,
);
