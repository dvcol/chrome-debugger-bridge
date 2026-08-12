import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify, styleText } from 'node:util';

const executeFile = promisify(execFile);
const publicPackageDirectories = ['birpc', 'core', 'extension', 'mcp', 'websocket'];
const dependencyFieldNames = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const corePackageName = '@dvcol/cdb';
const protocolJsonSchemaIdentifier = 'urn:dvcol:chrome-debugger-bridge:protocol:1';
const protocolJsonSchemaExportName = './protocol.schema.json';
const protocolJsonSchemaExportTarget = './dist/protocol.schema.json';
const workspaceRoot = process.cwd();

interface PackedPackageManifest {
  readonly name: string;
  readonly private?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly exports: Readonly<Record<string, unknown>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly sideEffects?: boolean;
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

interface ExampleCoverageEntry {
  readonly example: string;
  readonly exportName: string;
  readonly packageName: string;
  readonly subpath: string;
}

interface ExampleCoverageManifest {
  readonly entries: readonly ExampleCoverageEntry[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseExampleCoverageManifest(value: unknown): ExampleCoverageManifest {
  if (!isRecord(value) || !Array.isArray(value.entries) || value.entries.length === 0) {
    throw new TypeError('examples/coverage.json must declare at least one public factory coverage entry.');
  }
  const entries = value.entries.map((entry): ExampleCoverageEntry => {
    if (!isRecord(entry) || typeof entry.example !== 'string' || typeof entry.exportName !== 'string' || typeof entry.packageName !== 'string' || typeof entry.subpath !== 'string') {
      throw new TypeError('examples/coverage.json entries must declare string example, exportName, packageName, and subpath values.');
    }
    return {
      example: entry.example,
      exportName: entry.exportName,
      packageName: entry.packageName,
      subpath: entry.subpath,
    };
  });
  return { entries };
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
const exampleDirectories = ['birpc', 'browser-client', 'embedded', 'extension', 'mcp', 'node-client', 'standalone-host'];
const exampleCoverageManifest = parseExampleCoverageManifest(JSON.parse(
  await readFile(join(workspaceRoot, 'examples', 'coverage.json'), 'utf8'),
));

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

    if (manifest.sideEffects !== false) {
      throw new Error(`${manifest.name} must declare sideEffects: false for import-only public entries.`);
    }

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
    for (const exportValue of Object.values(manifest.exports)) {
      for (const importTarget of collectImportTargets(exportValue)) {
        if (importTarget.endsWith('.json')) continue;
        await readFile(join(extractedPackageDirectory, importTarget));
      }
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

const packedPackagesByName = new Map(packedPackages.map(packedPackage => [packedPackage.manifest.name, packedPackage]));
const coveredFactoryKeys = new Set<string>();
for (const coverageEntry of exampleCoverageManifest.entries) {
  const coverageImportSpecifier = createPackageImportSpecifier(coverageEntry.packageName, coverageEntry.subpath);
  const coveredFactoryKey = `${coverageImportSpecifier}:${coverageEntry.exportName}`;
  if (coveredFactoryKeys.has(coveredFactoryKey)) {
    throw new Error(`examples/coverage.json maps ${coveredFactoryKey} more than once.`);
  }
  coveredFactoryKeys.add(coveredFactoryKey);
  if (!exampleDirectories.includes(coverageEntry.example)) {
    throw new Error(`examples/coverage.json maps ${coveredFactoryKey} to unknown example ${coverageEntry.example}.`);
  }
  const packedPackage = packedPackagesByName.get(coverageEntry.packageName);
  if (packedPackage === undefined) {
    throw new Error(`examples/coverage.json maps ${coveredFactoryKey} to a package that is not packed.`);
  }
  if (!(coverageEntry.subpath in packedPackage.manifest.exports)) {
    throw new Error(`examples/coverage.json maps ${coveredFactoryKey} to missing export ${coverageEntry.subpath}.`);
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
    ['add', '--ignore-scripts', '--store-dir', populatedStoreDirectory, '@types/node@26.1.2'],
    { cwd: temporaryConsumerDirectory },
  );

  const runtimeImportSpecifiers = packedPackages.flatMap(({ runtimeImportSpecifiers }) => runtimeImportSpecifiers);
  await executeFile(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
const coverageEntries = ${JSON.stringify(exampleCoverageManifest.entries.map(coverageEntry => ({
  exportName: coverageEntry.exportName,
  importSpecifier: createPackageImportSpecifier(coverageEntry.packageName, coverageEntry.subpath),
})))};
const runtimeImportSpecifiers = ${JSON.stringify(runtimeImportSpecifiers)};
const coveredFactoryKeys = new Set(coverageEntries.map(({ exportName, importSpecifier }) => [importSpecifier, exportName].join(':')));
for (const { exportName, importSpecifier } of coverageEntries) {
  const exportedModule = await import(importSpecifier);
  if (typeof exportedModule[exportName] !== 'function') {
    throw new TypeError(['examples/coverage.json maps', [importSpecifier, exportName].join(':'), 'but it is not a runtime factory export.'].join(' '));
  }
}
for (const importSpecifier of runtimeImportSpecifiers) {
  const exportedModule = await import(importSpecifier);
  for (const [exportName, exportedValue] of Object.entries(exportedModule)) {
    if (!/^(?:connect|create|install|mount)/u.test(exportName) || typeof exportedValue !== 'function') continue;
    if (!coveredFactoryKeys.has([importSpecifier, exportName].join(':'))) {
      throw new TypeError([importSpecifier, exportName].join(':') + ' is a public factory without an example coverage entry.');
    }
  }
}
`,
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

  const packedExampleRoot = join(temporaryConsumerRoot, 'packed-examples');
  const packedArtifactPathsByName = new Map(packedPackages.map(({ artifactPath, manifest }) => [manifest.name, artifactPath]));
  await mkdir(join(packedExampleRoot, 'examples'), { recursive: true });
  await writeFile(
    join(packedExampleRoot, 'package.json'),
    `${JSON.stringify({ name: '@chrome-debugger-bridge-fixture/packed-examples', private: true, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  );
  const packedPackageOverrides = packedPackages
    .map(({ artifactPath, manifest }) => `  ${JSON.stringify(manifest.name)}: ${JSON.stringify(`file:${artifactPath}`)}`)
    .join('\n');
  await writeFile(
    join(packedExampleRoot, 'pnpm-workspace.yaml'),
    `packages:\n  - examples/*\ncatalog:\n  '@modelcontextprotocol/client': 2.0.0\noverrides:\n${packedPackageOverrides}\n`,
    'utf8',
  );

  for (const exampleDirectory of exampleDirectories) {
    const sourceDirectory = join(workspaceRoot, 'examples', exampleDirectory);
    const destinationDirectory = join(packedExampleRoot, 'examples', exampleDirectory);
    const readme = await readFile(join(sourceDirectory, 'README.md'), 'utf8').catch(() => undefined);
    if (readme === undefined || readme.trim().length === 0) {
      throw new Error(`examples/${exampleDirectory} must document its purpose, setup, security boundary, and runnable command.`);
    }
    if (!/\b(?:smoke|start)\b/u.test(readme)) {
      throw new Error(`examples/${exampleDirectory}/README.md must name a runnable command.`);
    }
    await cp(sourceDirectory, destinationDirectory, { recursive: true });
    const manifestPath = join(destinationDirectory, 'package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackedPackageManifest;
    if (manifest.private !== true || manifest.scripts?.smoke === undefined) {
      throw new Error(`examples/${exampleDirectory} must remain private and expose a smoke command.`);
    }
    const dependencies = Object.fromEntries(Object.entries(manifest.dependencies ?? {}).map(([dependencyName, dependencySpecifier]) => {
      const packedArtifactPath = packedArtifactPathsByName.get(dependencyName);
      return [dependencyName, packedArtifactPath === undefined ? dependencySpecifier : `file:${packedArtifactPath}`];
    }));
    if (Object.values(dependencies).some(dependencySpecifier => dependencySpecifier.startsWith('workspace:'))) {
      throw new Error(`examples/${exampleDirectory} retained a workspace source alias in its packed smoke consumer.`);
    }
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, dependencies }, null, 2)}\n`, 'utf8');
  }

  await executeFile('pnpm', ['install', '--ignore-scripts', '--store-dir', populatedStoreDirectory], { cwd: packedExampleRoot });
  for (const exampleDirectory of exampleDirectories) {
    const packageDirectory = join(packedExampleRoot, 'examples', exampleDirectory);
    await executeFile('pnpm', ['run', 'smoke'], { cwd: packageDirectory });
  }
  await copyFile(
    join(workspaceRoot, 'tests', 'fixtures', 'package-consumer', 'packed-generic-smoke.mjs'),
    join(packedExampleRoot, 'examples', 'browser-client', 'packed-generic-smoke.mjs'),
  );
  await executeFile(process.execPath, ['packed-generic-smoke.mjs'], { cwd: join(packedExampleRoot, 'examples', 'browser-client') });
  console.info(styleText('green', '✅ [examples]'), 'ran private example smoke commands against packed tarballs without workspace aliases');
} finally {
  await rm(temporaryConsumerRoot, { force: true, recursive: true });
}
