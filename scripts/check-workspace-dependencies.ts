import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { styleText } from 'node:util';

const dependencyFieldNames = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

type DependencyFieldName = (typeof dependencyFieldNames)[number];

interface PackageManifest {
  readonly name: string;
  readonly private?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

interface WorkspacePackage {
  readonly manifest: PackageManifest;
  readonly manifestPath: string;
}

const workspaceRoot = process.cwd();

async function findChildManifestPaths(parentDirectory: string): Promise<string[]> {
  const absoluteParentDirectory = join(workspaceRoot, parentDirectory);
  let directoryEntries;

  try {
    directoryEntries = await readdir(absoluteParentDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return directoryEntries
    .filter(directoryEntry => directoryEntry.isDirectory())
    .map(directoryEntry => join(parentDirectory, directoryEntry.name, 'package.json'));
}

async function readWorkspacePackage(manifestPath: string): Promise<WorkspacePackage> {
  const manifestContents = await readFile(join(workspaceRoot, manifestPath), 'utf8');
  return {
    manifest: JSON.parse(manifestContents) as PackageManifest,
    manifestPath,
  };
}

function expectedInternalSpecifier(workspacePackage: WorkspacePackage, dependencyFieldName: DependencyFieldName): string {
  if (workspacePackage.manifest.private === true || dependencyFieldName === 'devDependencies') {
    return 'workspace:*';
  }
  return 'workspace:^';
}

const manifestPaths = [
  'package.json',
  ...await findChildManifestPaths('packages'),
  ...await findChildManifestPaths('examples'),
  ...await findChildManifestPaths('tests/fixtures'),
];
const workspacePackages = await Promise.all(manifestPaths.map(readWorkspacePackage));
const internalPackageNames = new Set(workspacePackages.map(workspacePackage => workspacePackage.manifest.name));
const validationErrors: string[] = [];

for (const workspacePackage of workspacePackages) {
  for (const dependencyFieldName of dependencyFieldNames) {
    const dependencies = workspacePackage.manifest[dependencyFieldName] ?? {};

    for (const [dependencyName, dependencySpecifier] of Object.entries(dependencies)) {
      if (internalPackageNames.has(dependencyName)) {
        const expectedSpecifier = expectedInternalSpecifier(workspacePackage, dependencyFieldName);
        if (dependencySpecifier !== expectedSpecifier) {
          validationErrors.push(
            `${workspacePackage.manifestPath}: ${dependencyFieldName}.${dependencyName} must use ${expectedSpecifier}, received ${dependencySpecifier}`,
          );
        }
      } else if (!dependencySpecifier.startsWith('catalog:')) {
        validationErrors.push(
          `${workspacePackage.manifestPath}: ${dependencyFieldName}.${dependencyName} must use a named catalog, received ${dependencySpecifier}`,
        );
      }
    }
  }
}

if (validationErrors.length > 0) {
  for (const validationError of validationErrors) {
    console.error(styleText('red', '❌ [workspace]'), validationError);
  }
  process.exitCode = 1;
} else {
  console.info(styleText('green', '✅ [workspace]'), 'validated dependency protocols for', workspacePackages.length, 'workspace manifests');
}
