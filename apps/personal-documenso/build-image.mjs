import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const commit = '191170923a459afa003c846bd8501190a14f52d5';
const image = process.argv[2] || 'homix-personal-documenso:2.11.0-portal-1';
const platform = process.argv[3];
if (platform && !['linux/amd64', 'linux/arm64'].includes(platform)) {
  throw new Error('Optional platform must be linux/amd64 or linux/arm64');
}
if (!/^[a-z0-9./_-]*personal[a-z0-9./_-]*:[a-zA-Z0-9._-]+$/.test(image)) {
  throw new Error(
    'Use a distinct image name containing personal; never overwrite the company image',
  );
}
const directory = mkdtempSync(resolve(tmpdir(), 'homix-personal-build-'));
const source = resolve(directory, 'source');
function run(command, args, cwd = directory) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}
mkdirSync(source);
run('git', ['init'], source);
run('git', ['remote', 'add', 'origin', 'https://github.com/documenso/documenso.git'], source);
run('git', ['fetch', '--depth', '1', 'origin', commit], source);
run('git', ['checkout', '--detach', 'FETCH_HEAD'], source);
run(process.execPath, [resolve(here, 'prepare.mjs'), source]);
// Preserve a complete corresponding-source offer for this modified AGPL build.
const archive = resolve(directory, 'personal-signing-source.tar.gz');
run('tar', ['--exclude=.git', '--exclude=node_modules', '-czf', archive, '-C', source, '.']);
cpSync(archive, resolve(source, 'apps/remix/public/personal-signing-source.tar.gz'));
run(
  'docker',
  [
    'build',
    ...(platform ? ['--platform', platform] : []),
    '--file',
    'docker/Dockerfile',
    '--tag',
    image,
    '.',
  ],
  source,
);
process.stdout.write(
  `Built ${image}. No push or deployment performed. Build/source artifacts: ${directory}\n`,
);
