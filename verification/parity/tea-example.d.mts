export interface CargoSelection {
  reason: "compiler-artifact";
  manifest_path: string;
  package_id: string;
  target: { name: string; kind: string[]; src_path: string };
  features: string[];
  filenames: string[];
  executable: string | null;
  fresh: boolean;
}

export interface CargoLibrary {
  path: string;
  sha256: string;
  features: string[];
  packageId: string;
  artifact: CargoSelection;
  retainedPath: string;
  retainedSha256: string;
  retainedEncoding: "gzip";
  source: { path: string; sha256: string };
  manifest: { path: string; sha256: string };
}

export interface CargoArtifactProof {
  command: string[];
  cargoJson: string;
  cargoJsonSha256: string;
  cargoStderr: string;
  cargoStderrSha256: string;
  driver: CargoSelection;
  actualArtifact: string;
  binary: string;
  binarySha256: string;
  libraries: Record<string, CargoLibrary>;
  source: { path: string; sha256: string };
  sourceCommit: string;
  sourceDiff: string;
  sourceDiffSha256: string;
}

export function buildExample(
  cargo: string,
  packageName: "demlik-tea" | "demlik-code-graph" | "demlik-parity",
  example: string,
  reportFile: string,
  features?: readonly string[],
  env?: NodeJS.ProcessEnv,
): CargoArtifactProof;

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
