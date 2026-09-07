import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const artifactDirectory = join(process.cwd(), 'artifacts');

await rm(artifactDirectory, { force: true, recursive: true });
await mkdir(artifactDirectory, { recursive: true });
