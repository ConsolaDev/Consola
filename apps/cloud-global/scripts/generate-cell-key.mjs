// Prints a new Ed25519 private key for CELL_TOKEN_PRIVATE_KEY: a JSON Web Key on one line, the
// form the API reads. Put it in apps/cloud-global/.env, and nowhere else: anyone who has it can
// mint tokens every cell trusts.
//
//   pnpm --filter @consola/cloud-global cell-key:generate
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ed25519');
process.stdout.write(`${JSON.stringify(privateKey.export({ format: 'jwk' }))}\n`);
