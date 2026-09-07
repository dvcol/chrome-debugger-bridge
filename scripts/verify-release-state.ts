import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { glob, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { isGreater, isValid, normalizeFull } from 'verkit';

interface PackageManifest {
  readonly private?: boolean;
  readonly version: string;
}

const { values: { phase, version } } = parseArgs({
  options: { phase: { type: 'string' }, version: { type: 'string' } },
  args: process.argv.slice(2).filter(argument => argument !== '--'),
});
assert.ok(phase === 'before' || phase === 'after' || phase === 'current', '--phase must be before, after, or current.');
assert.ok(version !== undefined && isValid(version) && normalizeFull(version) === version, '--version must be an exact semantic version.');

function runGit(arguments_: readonly string[]): string {
  return execFileSync('git', arguments_, { encoding: 'utf8' }).trim();
}

const manifests = new Map<string, PackageManifest>();
for await (const manifestPath of glob(['package.json', 'packages/*/package.json'])) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest;
  if (manifestPath === 'package.json' || manifest.private !== true) manifests.set(manifestPath, manifest);
}
const currentVersion = manifests.get('package.json')?.version;
assert.ok(currentVersion !== undefined, 'The root manifest must declare a version.');
assert.ok([...manifests.values()].every(manifest => manifest.version === currentVersion), 'Release versions must be synchronized.');

if (phase === 'before') {
  assert.ok(isGreater(version, currentVersion), `${version} must be greater than ${currentVersion}.`);
} else {
  assert.equal(currentVersion, version, 'Manifest versions must match the release version.');
}

if (phase === 'after') {
  const changedPaths = runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n');
  assert.deepEqual(changedPaths.toSorted(), [...manifests.keys()].toSorted(), 'The release commit must change only release manifests.');
  assert.equal(runGit(['log', '-1', '--pretty=%s']), `chore: release v${version}`, 'Unexpected release commit message.');
  assert.equal(runGit(['rev-list', '-n', '1', `v${version}`]), runGit(['rev-parse', 'HEAD']), 'The tag must point to the release commit.');
}

if (phase !== 'current') {
  assert.equal(runGit(['status', '--porcelain']), '', 'The release checkout must be clean.');
}
