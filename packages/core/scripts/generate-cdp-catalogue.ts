import type { CdpCapabilityLevel } from './cdp-classification-policy.ts';

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { styleText } from 'node:util';

import browserProtocol from 'devtools-protocol/json/browser_protocol.json' with { type: 'json' };
import javascriptProtocol from 'devtools-protocol/json/js_protocol.json' with { type: 'json' };
import devtoolsProtocolPackage from 'devtools-protocol/package.json' with { type: 'json' };

import {
  cdpCapabilityLevels,
  commandLevelByDomain,
  commandLevelOverrides,
  eventLevelByDomain,
  eventLevelOverrides,
  kernelOwnedDomains,
  supportedChromeDebuggerDomains,
} from './cdp-classification-policy.ts';

interface ProtocolDefinition {
  readonly domains: readonly ProtocolDomain[];
  readonly version: {
    readonly major: string;
    readonly minor: string;
  };
}

interface ProtocolDomain {
  readonly commands?: readonly ProtocolEntry[];
  readonly domain: string;
  readonly events?: readonly ProtocolEntry[];
}

interface ProtocolEntry {
  readonly name: string;
}

interface ClassifiedProtocolEntry {
  readonly kind: 'command' | 'event';
  readonly level: CdpCapabilityLevel;
  readonly name: string;
}

const outputPath = join(import.meta.dirname, '..', 'src', 'cdp-catalogue.generated.ts');
const checkOnly = process.argv.includes('--check');
const supportedDomainNames = new Set<string>(supportedChromeDebuggerDomains);
const kernelOwnedDomainNames = new Set<string>(kernelOwnedDomains);
const protocolDefinitions = [browserProtocol, javascriptProtocol] as readonly ProtocolDefinition[];
const protocolDomains = protocolDefinitions
  .flatMap(protocolDefinition => protocolDefinition.domains)
  .filter(protocolDomain => supportedDomainNames.has(protocolDomain.domain));

function isKernelOwnedCommand(commandName: string): boolean {
  return commandName === 'enable' || commandName === 'disable';
}

function classifyEntry(domainName: string, entryName: string, kind: 'command' | 'event'): CdpCapabilityLevel {
  const qualifiedName = `${domainName}.${entryName}`;
  const overrides = kind === 'command' ? commandLevelOverrides : eventLevelOverrides;
  const override = overrides[qualifiedName as keyof typeof overrides];
  if (override !== undefined) return override;

  const defaults = kind === 'command' ? commandLevelByDomain : eventLevelByDomain;
  const defaultLevel = defaults[domainName as keyof typeof defaults];
  if (defaultLevel === undefined) throw new Error(`No ${kind} classification exists for ${qualifiedName}.`);
  return defaultLevel;
}

function collectEntries(): {
  readonly classifiedEntries: readonly ClassifiedProtocolEntry[];
  readonly kernelOwnedNames: readonly string[];
  readonly protocolDomainNames: ReadonlySet<string>;
} {
  const classifiedEntries: ClassifiedProtocolEntry[] = [];
  const kernelOwnedNames: string[] = [];
  const protocolDomainNames = new Set<string>();
  const clientFacingNames = new Set<string>();

  for (const protocolDomain of protocolDomains) {
    protocolDomainNames.add(protocolDomain.domain);
    for (const command of protocolDomain.commands ?? []) {
      const qualifiedName = `${protocolDomain.domain}.${command.name}`;
      if (kernelOwnedDomainNames.has(protocolDomain.domain) || isKernelOwnedCommand(command.name)) {
        kernelOwnedNames.push(qualifiedName);
        continue;
      }
      if (clientFacingNames.has(qualifiedName)) throw new Error(`Duplicate client-facing CDP name: ${qualifiedName}.`);
      clientFacingNames.add(qualifiedName);
      classifiedEntries.push({ kind: 'command', level: classifyEntry(protocolDomain.domain, command.name, 'command'), name: qualifiedName });
    }
    for (const event of protocolDomain.events ?? []) {
      const qualifiedName = `${protocolDomain.domain}.${event.name}`;
      if (kernelOwnedDomainNames.has(protocolDomain.domain)) {
        kernelOwnedNames.push(qualifiedName);
        continue;
      }
      if (clientFacingNames.has(qualifiedName)) throw new Error(`Duplicate client-facing CDP name: ${qualifiedName}.`);
      clientFacingNames.add(qualifiedName);
      classifiedEntries.push({ kind: 'event', level: classifyEntry(protocolDomain.domain, event.name, 'event'), name: qualifiedName });
    }
  }

  for (const overrideName of [...Object.keys(commandLevelOverrides), ...Object.keys(eventLevelOverrides)]) {
    if (!clientFacingNames.has(overrideName)) throw new Error(`Classification override does not match a client-facing CDP entry: ${overrideName}.`);
  }

  return {
    classifiedEntries: classifiedEntries.toSorted((left, right) => left.name.localeCompare(right.name)),
    kernelOwnedNames: kernelOwnedNames.toSorted((left, right) => left.localeCompare(right)),
    protocolDomainNames,
  };
}

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function renderStringArray(values: readonly string[], indentation: string): string {
  return values.map(value => `${indentation}${quote(value)},`).join('\n');
}

function renderGeneratedCatalogue(): string {
  const { classifiedEntries, kernelOwnedNames, protocolDomainNames } = collectEntries();
  const absentSupportedDomains = supportedChromeDebuggerDomains.filter(domainName => !protocolDomainNames.has(domainName));
  const catalogueLines = classifiedEntries.map(entry => `  '${entry.name}': { kind: '${entry.kind}', level: '${entry.level}' },`);
  const capabilityLevels = cdpCapabilityLevels.map(level => quote(level)).join(', ');
  const protocolVersion = `${browserProtocol.version.major}.${browserProtocol.version.minor}`;

  return `/** Generated by packages/core/scripts/generate-cdp-catalogue.ts. Do not edit directly. */

export const cdpCapabilityLevels = [${capabilityLevels}] as const;

export type CdpCapabilityLevel = typeof cdpCapabilityLevels[number];

export interface CdpCatalogueEntry {
  readonly kind: 'command' | 'event';
  readonly level: CdpCapabilityLevel;
}

export const cdpCatalogueMetadata = {
  absentSupportedDomains: [
${renderStringArray(absentSupportedDomains, '    ')}
  ],
  devtoolsProtocolVersion: ${quote(devtoolsProtocolPackage.version)},
  protocolVersion: ${quote(protocolVersion)},
  supportedDomains: [
${renderStringArray(supportedChromeDebuggerDomains, '    ')}
  ],
} as const;

export const cdpKernelOwnedNames = [
${renderStringArray(kernelOwnedNames, '  ')}
] as const;

export const cdpCapabilityCatalogue = {
${catalogueLines.join('\n')}
} as const satisfies Readonly<Record<string, CdpCatalogueEntry>>;
`;
}

const generatedCatalogue = renderGeneratedCatalogue();

if (checkOnly) {
  const existingCatalogue = await readFile(outputPath, 'utf8').catch(() => undefined);
  if (existingCatalogue !== generatedCatalogue) {
    console.error(styleText('red', '❌ [cdp-catalogue]'), 'generated catalogue is stale; run pnpm run catalogue:generate');
    process.exitCode = 1;
  } else {
    console.info(styleText('green', '✅ [cdp-catalogue]'), 'generated catalogue is current');
  }
} else {
  await writeFile(outputPath, generatedCatalogue, 'utf8');
  console.info(styleText('green', '✅ [cdp-catalogue]'), 'generated', outputPath);
}
