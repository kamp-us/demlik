export interface CargoLibrary {
  path: string;
  sha256: string;
  features: string[];
  packageId: string;
}

export interface CargoArtifactProof {
  command: string[];
  cargoJson: string;
  cargoJsonSha256: string;
  actualArtifact: string;
  binary: string;
  binarySha256: string;
  libraries: Record<string, CargoLibrary>;
  source: { path: string; sha256: string };
}

export function buildTeaExample(
  cargo: string,
  example: string,
  reportFile: string,
  features?: readonly string[],
): CargoArtifactProof;

export function buildTeaTest(
  cargo: string,
  test: string,
  reportFile: string,
): CargoArtifactProof;

export function buildParityBinary(
  cargo: string,
  name: string,
  reportFile: string,
): CargoArtifactProof;
