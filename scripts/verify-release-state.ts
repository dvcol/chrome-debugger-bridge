import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

interface PackageManifest {
  readonly name: string;
  readonly private?: boolean;
  readonly version?: string;
}

interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (number | string)[];
}

const semanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const numericIdentifierPattern = /^\d+$/u;
const workspaceRoot = process.cwd();

function readArgument(name: string): string {
  const argumentIndex = process.argv.indexOf(name);
  const value = argumentIndex < 0 ? undefined : process.argv[argumentIndex + 1];
  if (value === undefined || value.startsWith('--')) throw new TypeError(`Missing ${name} argument.`);
  return value;
}

function parseVersion(version: string): ParsedVersion {
  const match = semanticVersionPattern.exec(version);
  if (match === null) throw new TypeError(`${version} is not a valid semantic version.`);
  const prerelease = match[4]?.split('.').map((identifier) => {
    if (!numericIdentifierPattern.test(identifier)) return identifier;
    if (identifier.length > 1 && identifier.startsWith('0')) {
      throw new TypeError(`${version} is not a valid semantic version.`);
    }
    return Number(identifier);
  }) ?? [];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareVersions(leftVersion: string, rightVersion: string): number {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const maximumIdentifierCount = Math.max(left.prerelease.length, right.prerelease.length);
  for (let identifierIndex = 0; identifierIndex < maximumIdentifierCount; identifierIndex += 1) {
    const leftIdentifier = left.prerelease[identifierIndex];
    const rightIdentifier = right.prerelease[identifierIndex];
    if (leftIdentifier === rightIdentifier) continue;
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (typeof leftIdentifier === 'number' && typeof rightIdentifier === 'number') return leftIdentifier - rightIdentifier;
    if (typeof leftIdentifier === 'number') return -1;
    if (typeof rightIdentifier === 'number') return 1;
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

function runGit(arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, { cwd: workspaceRoot, encoding: 'utf8' }).trim();
}

async function readManifest(manifestPath: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
}

async function discoverReleaseManifestPaths(): Promise<readonly string[]> {
  const manifestPaths = [join(workspaceRoot, 'package.json')];
  const packageEntries = await readdir(join(workspaceRoot, 'packages'), { withFileTypes: true });
  for (const packageEntry of packageEntries) {
    if (!packageEntry.isDirectory()) continue;
    const manifestPath = join(workspaceRoot, 'packages', packageEntry.name, 'package.json');
    const manifestContents = await readFile(manifestPath, 'utf8').catch(() => undefined);
    if (manifestContents === undefined) continue;
    const manifest = JSON.parse(manifestContents) as PackageManifest;
    if (manifest.private !== true) manifestPaths.push(manifestPath);
  }
  return manifestPaths.toSorted();
}

const expectedVersion = readArgument('--version');
const phase = readArgument('--phase');
parseVersion(expectedVersion);
if (phase !== 'before' && phase !== 'after' && phase !== 'current') {
  throw new TypeError('--phase must be before, after, or current.');
}

const releaseManifestPaths = await discoverReleaseManifestPaths();
const releaseManifests = await Promise.all(releaseManifestPaths.map(readManifest));
const manifestVersions = new Set(releaseManifests.map(manifest => manifest.version));
if (manifestVersions.size !== 1 || manifestVersions.has(undefined)) {
  throw new Error('The root and all public package manifests must have one synchronized version.');
}
const [currentVersion] = manifestVersions;
if (currentVersion === undefined) throw new Error('Release manifests must declare a version.');

if (phase === 'current') {
  if (currentVersion !== expectedVersion) {
    throw new Error(`Workspace version is ${currentVersion}; expected ${expectedVersion}.`);
  }
} else if (phase === 'before') {
  if (compareVersions(expectedVersion, currentVersion) <= 0) {
    throw new Error(`Release version ${expectedVersion} must be greater than current version ${currentVersion}.`);
  }
  if (runGit(['status', '--porcelain']).length > 0) throw new Error('The release checkout must be clean before Bumpp runs.');
} else {
  if (currentVersion !== expectedVersion) {
    throw new Error(`Bumpp produced ${currentVersion}; expected ${expectedVersion}.`);
  }
  const expectedManifestPaths = new Set(releaseManifestPaths.map(manifestPath => relative(workspaceRoot, manifestPath)));
  const changedPaths = runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n').filter(Boolean);
  if (changedPaths.length !== expectedManifestPaths.size
    || changedPaths.some(changedPath => !expectedManifestPaths.has(changedPath))) {
    throw new Error(`Release commit changed unexpected files: ${changedPaths.join(', ')}`);
  }
  const expectedTag = `v${expectedVersion}`;
  if (runGit(['log', '-1', '--pretty=%s']) !== `chore: release ${expectedTag}`) {
    throw new Error('Release commit message does not match the release tag.');
  }
  if (runGit(['rev-list', '-n', '1', expectedTag]) !== runGit(['rev-parse', 'HEAD'])) {
    throw new Error(`${expectedTag} does not point to the release commit.`);
  }
  if (runGit(['status', '--porcelain']).length > 0) throw new Error('Bumpp left uncommitted release changes.');
}
