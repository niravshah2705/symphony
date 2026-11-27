import type { BundleBase, PkgFamily } from '@fleet-local/shared';
import { PACKS } from './packs.generated.ts';

// Read-side helpers over the generated catalog mirror. This module is the only
// place fleet-local decides whether a pack can go into a bundle, and it decides
// it from the matrix cells — never from `requirements.appliedTo`, which is stale
// (it names go/harness/codex-sdk and go/harness/dsh, paths that do not exist).

export interface PackCell {
  status: 'built' | 'bundled' | 'declared' | 'unsupported';
  engine: string;
  version?: string;
  blockedOn?: string;
  limitations?: string[];
}

export interface PackRequirements {
  packages: string[];
  dockerfile: string[];
  dockerfileAlpine?: string[];
  writablePaths?: string[];
}

export interface Pack {
  id: string;
  kind: 'plugin' | 'skill';
  label: string;
  version: string;
  dataImage?: string;
  dataDigest?: string;
  requirements: PackRequirements;
  cells: Record<string, PackCell>;
  promptAppend: string;
}

export const ALL_PACKS: readonly Pack[] = PACKS as unknown as Pack[];

export const packById = (id: string): Pack | undefined => ALL_PACKS.find((p) => p.id === id);

export type Availability =
  /** The pack declares a live cell for this runtime: include its requirement lines. */
  | 'offerable'
  /** The cell is unsupported and names exactly this runtime image as the blocker,
      which is the image a successful bundle build produces. Selectable, but the
      combination has never been exercised. */
  | 'unblocks-here'
  /** The cell is unsupported and waits on something else. */
  | 'blocked-elsewhere'
  /** The runtime has no matrix column at all, so no pack has ever been graded against it. */
  | 'no-column'
  /** The pack carries no cell for a runtime that does have a column. */
  | 'not-listed';

export interface PackVerdict {
  pack: Pack;
  availability: Availability;
  reason: string;
}

// blockedOn is a Dockerfile path, and the catalog and the runtime CSV do not
// agree on the basename (the catalog writes go/harness/dsh/Dockerfile for the
// runtime the CSV calls deepseek), so the match is on either spelling.
const namesThisBase = (blockedOn: string | undefined, base: BundleBase): boolean => {
  if (!blockedOn) return false;
  const segment = blockedOn.split('/').filter(Boolean).slice(-2, -1)[0];
  return Boolean(segment) && (segment === base.matrixColumn || segment === base.runtime);
};

export function availabilityOf(pack: Pack, base: BundleBase): PackVerdict {
  if (base.matrixColumn === '') {
    return { pack, availability: 'no-column', reason: `${base.runtime} is not a plugin matrix column` };
  }
  const cell = pack.cells[base.matrixColumn];
  if (!cell) {
    return { pack, availability: 'not-listed', reason: `${pack.id} declares no ${base.matrixColumn} cell` };
  }
  if (cell.status !== 'unsupported') {
    return { pack, availability: 'offerable', reason: `declared as ${cell.status}` };
  }
  if (namesThisBase(cell.blockedOn, base)) {
    return {
      pack,
      availability: 'unblocks-here',
      reason: `unsupported until a ${base.runtime} runtime image carries its requirements — this build is that image`,
    };
  }
  return { pack, availability: 'blocked-elsewhere', reason: cell.blockedOn ?? cell.limitations?.[0] ?? 'unsupported' };
}

export function packsFor(base: BundleBase): PackVerdict[] {
  return ALL_PACKS.map((pack) => availabilityOf(pack, base));
}

/** Ids the plan step will accept: live cells, plus the ones this very image unblocks. */
export function selectablePackIds(base: BundleBase): string[] {
  return packsFor(base)
    .filter((v) => v.availability === 'offerable' || v.availability === 'unblocks-here')
    .map((v) => v.pack.id);
}

// Same contract as requirementLines() in the root plugin-catalog: an alpine base
// gets apk lines or nothing. Returning null instead of the apt default is the
// point — apt-get does not exist there, and finding that out inside a ten-minute
// Cloud Build job is the expensive version of this check.
export function requirementLines(requirements: PackRequirements | undefined, family: PkgFamily): string[] | null {
  if (!requirements) return null;
  if (family === 'apk') {
    return requirements.dockerfileAlpine?.length ? requirements.dockerfileAlpine : null;
  }
  return requirements.dockerfile?.length ? requirements.dockerfile : null;
}
