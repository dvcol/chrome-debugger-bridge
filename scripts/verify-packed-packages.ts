import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify, styleText } from 'node:util';

const executeFile = promisify(execFile);
const publicPackageDirectories = ['core', 'devframe', 'extension', 'mcp', 'websocket'];
const dependencyFieldNames = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const corePackageName = '@dvcol/chrome-debugger-bridge';
const protocolJsonSchemaIdentifier = 'urn:dvcol:chrome-debugger-bridge:protocol:1';
const protocolJsonSchemaExportName = './protocol.schema.json';
const protocolJsonSchemaExportTarget = './dist/protocol.schema.json';
const workspaceRoot = process.cwd();

interface PackedPackageManifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

interface JsonSchemaDocument {
  readonly $id?: unknown;
  readonly $schema?: unknown;
}

interface InstalledModulesMetadata {
  readonly storeDir: string;
}

interface PackedPackage {
  readonly artifactName: string;
  readonly artifactPath: string;
  readonly manifest: PackedPackageManifest;
  readonly runtimeImportSpecifiers: readonly string[];
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

function createPackageImportSpecifier(packageName: string, exportName: string): string {
  if (exportName === '.') {
    return packageName;
  }
  if (!exportName.startsWith('./')) {
    throw new Error(`${packageName} exposes unsupported export name ${exportName}`);
  }
  return `${packageName}/${exportName.slice(2)}`;
}

const packedPackages: PackedPackage[] = [];

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

    if (manifest.name === corePackageName) {
      const schemaExportTarget = manifest.exports[protocolJsonSchemaExportName];
      if (schemaExportTarget !== protocolJsonSchemaExportTarget) {
        throw new Error(
          `${manifest.name} must export ${protocolJsonSchemaExportName} as ${protocolJsonSchemaExportTarget}`,
        );
      }

      const schemaContents = await readFile(join(extractedPackageDirectory, protocolJsonSchemaExportTarget), 'utf8');
      const schemaDocument = JSON.parse(schemaContents) as JsonSchemaDocument;
      if (schemaDocument.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
        throw new Error(`${manifest.name} must publish a Draft 2020-12 protocol JSON Schema`);
      }
      if (schemaDocument.$id !== protocolJsonSchemaIdentifier) {
        throw new Error(`${manifest.name} must publish protocol JSON Schema ${protocolJsonSchemaIdentifier}`);
      }
    }

    for (const dependencyFieldName of dependencyFieldNames) {
      const dependencies = manifest[dependencyFieldName] ?? {};
      for (const [dependencyName, dependencySpecifier] of Object.entries(dependencies)) {
        if (dependencySpecifier.startsWith('catalog:') || dependencySpecifier.startsWith('workspace:')) {
          throw new Error(`${manifest.name} packed ${dependencyFieldName}.${dependencyName} as ${dependencySpecifier}`);
        }
      }
    }

    const runtimeImportSpecifiers = Object.entries(manifest.exports).flatMap(([exportName, exportValue]) => {
      const importTargets = collectImportTargets(exportValue);
      return importTargets.some(importTarget => !importTarget.endsWith('.json'))
        ? [createPackageImportSpecifier(manifest.name, exportName)]
        : [];
    });

    if (runtimeImportSpecifiers.length === 0) {
      throw new Error(`${manifest.name} exposes no importable runtime entry`);
    }
    packedPackages.push({
      artifactName,
      artifactPath,
      manifest,
      runtimeImportSpecifiers,
    });
  } finally {
    await rm(extractionDirectory, { force: true, recursive: true });
  }
}

const temporaryConsumerRoot = await mkdtemp(join(tmpdir(), 'chrome-debugger-bridge-consumer-'));
const temporaryConsumerDirectory = join(temporaryConsumerRoot, 'package-consumer');
const installedModulesMetadata = JSON.parse(
  await readFile(join(workspaceRoot, 'node_modules', '.modules.yaml'), 'utf8'),
) as InstalledModulesMetadata;
const populatedStoreDirectory = dirname(installedModulesMetadata.storeDir);

try {
  await mkdir(temporaryConsumerDirectory);
  await Promise.all([
    copyFile(
      join(workspaceRoot, 'tests', 'fixtures', 'package-consumer', 'browser-transport-consumer.ts'),
      join(temporaryConsumerDirectory, 'browser-transport-consumer.ts'),
    ),
    copyFile(
      join(workspaceRoot, 'tests', 'fixtures', 'package-consumer', 'protocol-consumer.ts'),
      join(temporaryConsumerDirectory, 'protocol-consumer.ts'),
    ),
    copyFile(
      join(workspaceRoot, 'tests', 'fixtures', 'package-consumer', 'transport-consumer.ts'),
      join(temporaryConsumerDirectory, 'transport-consumer.ts'),
    ),
    copyFile(
      join(workspaceRoot, 'tests', 'fixtures', 'package-consumer', 'tsconfig.json'),
      join(temporaryConsumerDirectory, 'tsconfig.json'),
    ),
    copyFile(
      join(workspaceRoot, 'tests', 'fixtures', 'package-consumer', 'tsconfig.browser.json'),
      join(temporaryConsumerDirectory, 'tsconfig.browser.json'),
    ),
  ]);
  await writeFile(
    join(temporaryConsumerDirectory, 'package.json'),
    `${JSON.stringify({
      name: '@chrome-debugger-bridge-fixture/packed-package-consumer',
      private: true,
      type: 'module',
      version: '0.0.0',
    }, null, 2)}\n`,
    'utf8',
  );

  const packageOverrides = packedPackages
    .map(({ artifactPath, manifest }) => `  ${JSON.stringify(manifest.name)}: ${JSON.stringify(`file:${artifactPath}`)}`)
    .join('\n');
  await writeFile(
    join(temporaryConsumerDirectory, 'pnpm-workspace.yaml'),
    `overrides:\n${packageOverrides}\n`,
    'utf8',
  );

  await executeFile(
    'pnpm',
    [
      'add',
      '--offline',
      '--ignore-scripts',
      '--store-dir',
      populatedStoreDirectory,
      ...packedPackages.map(({ artifactPath }) => artifactPath),
    ],
    { cwd: temporaryConsumerDirectory },
  );

  await executeFile(
    'pnpm',
    ['exec', 'tsc', '--noEmit', '--project', join(temporaryConsumerDirectory, 'tsconfig.browser.json')],
    { cwd: workspaceRoot },
  );
  await executeFile(
    'pnpm',
    ['add', '--offline', '--ignore-scripts', '--store-dir', populatedStoreDirectory, '@types/node@26.1.2'],
    { cwd: temporaryConsumerDirectory },
  );

  const runtimeImportSpecifiers = packedPackages.flatMap(({ runtimeImportSpecifiers }) => runtimeImportSpecifiers);
  await executeFile(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `for (const importSpecifier of ${JSON.stringify(runtimeImportSpecifiers)}) await import(importSpecifier);`,
    ],
    { cwd: temporaryConsumerDirectory },
  );
  await executeFile(
    'pnpm',
    ['exec', 'tsc', '--noEmit', '--project', join(temporaryConsumerDirectory, 'tsconfig.json')],
    { cwd: workspaceRoot },
  );

  for (const { artifactName, manifest, runtimeImportSpecifiers: packageRuntimeImportSpecifiers } of packedPackages) {
    console.info(
      styleText('green', '✅ [package]'),
      manifest.name,
      'imports',
      packageRuntimeImportSpecifiers.length,
      'runtime entries and compiles from',
      artifactName,
    );
  }
} finally {
  await rm(temporaryConsumerRoot, { force: true, recursive: true });
}
