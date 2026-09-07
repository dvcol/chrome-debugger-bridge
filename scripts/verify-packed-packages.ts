import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, glob, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify, styleText } from 'node:util';

interface PackageManifest {
  readonly name: string;
  readonly private?: boolean;
  readonly version: string;
  readonly exports?: Readonly<Record<string, string | Readonly<Record<string, unknown>>>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

const executeFile = promisify(execFile);
const workspaceRoot = process.cwd();
const packageDefinitions: { directory: string; manifest: PackageManifest; artifactPath: string }[] = [];
const ignoredDirectories = new Set(['node_modules', 'dist', 'artifacts', '.turbo']);

async function readManifest(manifestPath: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
}

for await (const manifestPath of glob('packages/*/package.json')) {
  const manifest = await readManifest(manifestPath);
  if (manifest.private === true) continue;
  const directory = dirname(manifestPath);
  packageDefinitions.push({ directory, manifest, artifactPath: join(workspaceRoot, directory, 'artifacts', 'package.tgz') });
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'cdb-package-consumers-'));
try {
  const imports: string[] = [];
  for (const { directory, manifest, artifactPath } of packageDefinitions) {
    const extractionDirectory = join(temporaryRoot, directory);
    await mkdir(extractionDirectory, { recursive: true });
    await executeFile('tar', ['-xzf', artifactPath, '-C', extractionDirectory]);
    const extractedDirectory = join(extractionDirectory, 'package');
    const packedManifest = await readManifest(join(extractedDirectory, 'package.json'));
    assert.equal(packedManifest.name, manifest.name);
    assert.equal(packedManifest.version, manifest.version);
    await Promise.all(['README.md', 'LICENSE'].map(async file => readFile(join(extractedDirectory, file), 'utf8')));

    const dependencySpecifiers = Object.values({
      ...packedManifest.dependencies,
      ...packedManifest.devDependencies,
      ...packedManifest.optionalDependencies,
      ...packedManifest.peerDependencies,
    });
    assert.ok(dependencySpecifiers.every(specifier => !specifier.startsWith('workspace:') && !specifier.startsWith('catalog:')), `${manifest.name} contains unresolved workspace dependencies.`);

    for (const [subpath, target] of Object.entries(packedManifest.exports ?? {})) {
      if (typeof target === 'string' ? target.endsWith('.json') : !('import' in target)) continue;
      imports.push(subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`);
    }
  }

  const packageOverrides = packageDefinitions.map(({ manifest, artifactPath }) =>
    `  ${JSON.stringify(manifest.name)}: ${JSON.stringify(`file:${artifactPath}`)}`).join('\n');
  const modulesMetadata = JSON.parse(await readFile(join(workspaceRoot, 'node_modules', '.modules.yaml'), 'utf8')) as { storeDir: string };
  const storeDirectory = dirname(modulesMetadata.storeDir);
  const consumerDirectory = join(temporaryRoot, 'consumer');
  await mkdir(consumerDirectory);
  const fixtureDirectory = join(workspaceRoot, 'tests', 'fixtures', 'package-consumer');
  for await (const filename of glob('*.{ts,json}', { cwd: fixtureDirectory })) {
    await copyFile(join(fixtureDirectory, filename), join(consumerDirectory, filename));
  }
  await writeFile(join(consumerDirectory, 'package.json'), JSON.stringify({ private: true, type: 'module', version: '0.0.0' }));
  await writeFile(join(consumerDirectory, 'pnpm-workspace.yaml'), `overrides:\n${packageOverrides}\n`);
  await executeFile('pnpm', [
    'add',
    '--ignore-scripts',
    '--store-dir',
    storeDirectory,
    ...packageDefinitions.map(({ artifactPath }) => artifactPath),
  ], { cwd: consumerDirectory });
  await executeFile('pnpm', ['exec', 'tsc', '--noEmit', '--project', join(consumerDirectory, 'tsconfig.browser.json')]);

  const nodeTypesManifest = await readManifest(join(workspaceRoot, 'node_modules', '@types', 'node', 'package.json'));
  await executeFile('pnpm', [
    'add',
    '--ignore-scripts',
    '--store-dir',
    storeDirectory,
    `@types/node@${nodeTypesManifest.version}`,
  ], { cwd: consumerDirectory });
  await writeFile(join(consumerDirectory, 'imports.ts'), imports.map(specifier => `import ${JSON.stringify(specifier)};`).join('\n'));
  await executeFile('pnpm', ['exec', 'tsc', '--noEmit', '--project', join(consumerDirectory, 'tsconfig.json')]);
  await executeFile(process.execPath, ['imports.ts'], { cwd: consumerDirectory });
  await executeFile(process.execPath, ['packed-generic-smoke.ts'], { cwd: consumerDirectory });
  console.info(styleText('green', '✅ [packages]'), 'compiled and imported', imports.length, 'entries from', packageDefinitions.length, 'tarballs; transport smoke passed');

  const exampleRoot = join(temporaryRoot, 'examples');
  await mkdir(exampleRoot);
  await writeFile(join(exampleRoot, 'package.json'), JSON.stringify({ private: true, type: 'module', version: '0.0.0' }));
  await writeFile(join(exampleRoot, 'pnpm-workspace.yaml'), `${await readFile(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8')}\noverrides:\n${packageOverrides}\n`);
  const packagePaths = new Map(packageDefinitions.map(({ manifest, artifactPath }) => [manifest.name, `file:${artifactPath}`]));
  const exampleDirectories: string[] = [];
  for await (const manifestPath of glob('examples/*/package.json')) {
    const directory = dirname(manifestPath);
    const manifest = await readManifest(manifestPath);
    if (manifest.scripts?.smoke === undefined) continue;
    const destination = join(exampleRoot, directory);
    await cp(join(workspaceRoot, directory), destination, {
      recursive: true,
      filter: source => !ignoredDirectories.has(basename(source)),
    });
    const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {})
      .map(([name, specifier]) => [name, packagePaths.get(name) ?? specifier]));
    await writeFile(join(destination, 'package.json'), JSON.stringify({ ...manifest, dependencies }, null, 2));
    exampleDirectories.push(destination);
  }
  await executeFile('pnpm', ['install', '--ignore-scripts', '--store-dir', storeDirectory], { cwd: exampleRoot });
  for (const directory of exampleDirectories) {
    await executeFile('pnpm', ['run', 'smoke'], { cwd: directory });
    console.info(styleText('green', '✅ [example]'), basename(directory), 'passed against packed packages');
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
