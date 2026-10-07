import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const image = process.argv[2] || 'homix-company-documenso:2.18.0-notifications';
if (!/^[a-z0-9./_-]*company[a-z0-9./_-]*:[a-zA-Z0-9._-]+$/.test(image))
  throw new Error('Use a distinct image containing company; do not overwrite the personal engine');
const directory = mkdtempSync(resolve(tmpdir(), 'homix-company-build-'));
const source = resolve(directory, 'source');
function run(command, args, cwd = directory) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}
mkdirSync(source);
run('git', ['init'], source);
run('git', ['remote', 'add', 'origin', 'https://github.com/documenso/documenso.git'], source);
run('git', ['fetch', '--depth', '1', 'origin', '389390c884949fe27c240488a3259da3cdba93e0'], source);
run('git', ['checkout', '--detach', 'FETCH_HEAD'], source);
run(process.execPath, [resolve(here, 'prepare.mjs'), source]);
const archive = resolve(directory, 'company-signing-source.tar.gz');
run('tar', ['--exclude=.git', '--exclude=node_modules', '-czf', archive, '-C', source, '.']);
cpSync(archive, resolve(source, 'apps/remix/public/company-signing-source.tar.gz'));
run(
  'docker',
  ['build', '--platform', 'linux/amd64', '--file', 'docker/Dockerfile', '--tag', image, '.'],
  source,
);
process.stdout.write(`Built ${image}. No push or deployment performed. Source: ${directory}\n`);
