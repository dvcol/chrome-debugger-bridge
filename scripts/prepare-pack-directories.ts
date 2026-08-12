import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const publicPackageDirectories = ['birpc', 'core', 'extension', 'mcp', 'websocket'];
const workspaceRoot = process.cwd();

await Promise.all(publicPackageDirectories.map(async (publicPackageDirectory) => {
  const artifactDirectory = join(workspaceRoot, 'packages', publicPackageDirectory, 'artifacts');
  await rm(artifactDirectory, { force: true, recursive: true });
  await mkdir(artifactDirectory, { recursive: true });
}));
