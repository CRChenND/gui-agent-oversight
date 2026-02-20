import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const tmpDir = path.join(rootDir, '.tmp-e2e');
const bundledEntry = path.join(tmpDir, 'runtimePhase3.e2e.bundle.mjs');

if (fs.existsSync(tmpDir)) {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

execSync(
  `npx esbuild src/tests/runtimePhase3.e2e.test.ts --bundle --platform=node --format=esm --outfile="${bundledEntry}"`,
  {
    cwd: rootDir,
    stdio: 'inherit',
  }
);

execSync(`node "${bundledEntry}"`, {
  cwd: rootDir,
  stdio: 'inherit',
});
