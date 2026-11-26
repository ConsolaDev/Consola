// Prints a new Ed25519 private key for PASS_PRIVATE_KEY: a JSON Web Key on one line, the form
// the cell reads. Put it in apps/cloud-region/.env, and nowhere else: anyone who has it can sign
// passes every session host of the cell accepts. It is the cell's own key, never cloud-global's
// CELL_TOKEN_PRIVATE_KEY.
//
//   pnpm --filter @consola/cloud-region pass-key:generate
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ed25519');
process.stdout.write(`${JSON.stringify(privateKey.export({ format: 'jwk' }))}\n`);
