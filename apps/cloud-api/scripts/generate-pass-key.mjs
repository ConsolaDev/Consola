// Prints a new Ed25519 private key for PASS_PRIVATE_KEY: a JSON Web Key on one line, the form
// the API reads. Put it in apps/cloud-api/.env, and nowhere else: anyone who has it can sign
// passes every session host of the API accepts.
//
//   pnpm --filter @consola/cloud-api pass-key:generate
import { generateKeyPairSync } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ed25519');
process.stdout.write(`${JSON.stringify(privateKey.export({ format: 'jwk' }))}\n`);
