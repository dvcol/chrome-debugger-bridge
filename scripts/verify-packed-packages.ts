import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify, styleText } from 'node:util';

const executeFile = promisify(execFile);
const publicPackageDirectories = ['core', 'devframe', 'extension', 'mcp', 'websocket'];
const dependencyFieldNames = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const workspaceRoot = process.cwd();

interface PackedPackageManifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

function collectImportTargets(exportValue: unknown): string[] {
  if (typeof exportValue === 'string') {
    return [exportValue];
  }
  if (exportValue === null || typeof exportValue !== 'object' || Array.isArray(exportValue)) {
    return [];
  }

  const exportConditions = exportValue as Readonly<Record<string, unknown>>;
  if (typeof exportConditions.import === 'string') {
    return [exportConditions.import];
  }
  if (typeof exportConditions.default === 'string') {
    return [exportConditions.default];
  }
  return Object.values(exportConditions).flatMap(collectImportTargets);
}

for (const publicPackageDirectory of publicPackageDirectories) {
  const artifactDirectory = join(workspaceRoot, 'packages', publicPackageDirectory, 'artifacts');
  const artifactNames = (await readdir(artifactDirectory)).filter(artifactName => artifactName.endsWith('.tgz'));
  if (artifactNames.length !== 1) {
    throw new Error(`Expected one packed archive in ${artifactDirectory}, received ${artifactNames.length}`);
  }

  const artifactName = artifactNames[0];
  if (artifactName === undefined) {
    throw new Error(`Packed archive disappeared from ${artifactDirectory}`);
  }
  const artifactPath = join(artifactDirectory, artifactName);
  const extractionDirectory = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-package-'));

  try {
    await executeFile('tar', ['-xzf', artifactPath, '-C', extractionDirectory]);
    const extractedPackageDirectory = join(extractionDirectory, 'package');
    const manifest = JSON.parse(await readFile(join(extractedPackageDirectory, 'package.json'), 'utf8')) as PackedPackageManifest;

    for (const dependencyFieldName of dependencyFieldNames) {
      const dependencies = manifest[dependencyFieldName] ?? {};
      for (const [dependencyName, dependencySpecifier] of Object.entries(dependencies)) {
        if (dependencySpecifier.startsWith('catalog:') || dependencySpecifier.startsWith('workspace:')) {
          throw new Error(`${manifest.name} packed ${dependencyFieldName}.${dependencyName} as ${dependencySpecifier}`);
        }
      }
    }

    const importedTargets = new Set<string>();
    for (const exportValue of Object.values(manifest.exports)) {
      for (const importTarget of collectImportTargets(exportValue)) {
        if (importTarget.endsWith('.json')) {
          continue;
        }
        const absoluteImportTarget = join(extractedPackageDirectory, importTarget);
        await import(pathToFileURL(absoluteImportTarget).href);
        importedTargets.add(importTarget);
      }
    }

    if (importedTargets.size === 0) {
      throw new Error(`${manifest.name} exposes no importable runtime entry`);
    }
    console.info(styleText('green', '✅ [package]'), manifest.name, 'imports', importedTargets.size, 'runtime entries from', artifactName);
  } finally {
    await rm(extractionDirectory, { force: true, recursive: true });
  }
}
