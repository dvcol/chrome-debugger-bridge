import type { CdpCatalogueEntry } from './cdp-catalogue.generated.js';
import type { CapabilityGrant, LeaseMode } from './protocol.js';

import { cdpCapabilityCatalogue, cdpCapabilityLevels, cdpKernelOwnedNames } from './cdp-catalogue.generated.js';

const capabilityLevelIndex = new Map(cdpCapabilityLevels.map((level, index) => [level, index]));
const catalogue: Readonly<Record<string, CdpCatalogueEntry>> = cdpCapabilityCatalogue;
const bridgeCatalogue: Readonly<Record<string, CdpCatalogueEntry>> = {
  'Bridge.childSessionAttached': { kind: 'event', level: 'observe' },
};
const kernelOwnedNames = new Set<string>(cdpKernelOwnedNames);

export type CdpNameKind = 'command' | 'event';

/** Resolves the catalogue and exact-name grant without inspecting native CDP payloads. */
export function isCdpNameAllowed(grant: CapabilityGrant, name: string, kind: CdpNameKind): boolean {
  if (kernelOwnedNames.has(name)) return false;
  const entry = catalogue[name] ?? bridgeCatalogue[name];
  if (entry !== undefined && entry.kind !== kind) return false;
  if (grant.allow?.includes(name) ?? false) return true;
  const grantLevel = grant.level ?? 'observe';
  if (grantLevel === 'unsafe') return true;
  return entry !== undefined
    && (capabilityLevelIndex.get(entry.level) ?? Infinity) <= (capabilityLevelIndex.get(grantLevel) ?? -1);
}

/** Higher-risk and exact-name authority is intentionally serialized through a controller lease. */
export function requiredLeaseMode(grant: CapabilityGrant, names: readonly string[]): LeaseMode {
  if (names.some((name) => {
    const entry = catalogue[name] ?? bridgeCatalogue[name];
    return entry === undefined || (grant.allow?.includes(name) ?? false) || entry.level === 'interact' || entry.level === 'debug' || entry.level === 'unsafe';
  })) return 'exclusive-control';
  return 'shared-read';
}
