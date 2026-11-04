// Gera o hash para SUPERADMIN_PASSWORD_HASH sem a senha passar pela linha de comando.
//   node scripts/hash-password.js            (digite a senha e aperte Ctrl+D)
//   printf '%s' "$SENHA" | node scripts/hash-password.js
import { hashPassword, passwordProblem } from '../lib/auth.js';

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

const pw = await readStdin();
const problem = passwordProblem(pw);
if (problem) {
  console.error(problem);
  process.exit(1);
}
console.log(await hashPassword(pw));
