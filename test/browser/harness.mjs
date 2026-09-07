// Some tests need the extension to already hold host permissions, because
// granting an optional permission requires a click on a Chrome dialog that
// automation cannot reach.
//
// Rather than weakening the shipped manifest, this copies the extension to a
// temporary directory and adds host_permissions there. The code under test
// is the real code; only the grant is shortcut.

import { cp, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function buildGrantedExtension(root) {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-ext-'));
  await cp(root, dir, {
    recursive: true,
    filter: (source) => !source.includes('node_modules') && !source.includes(path.sep + '.git'),
  });

  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['*://*/*'];
  delete manifest.optional_host_permissions;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
