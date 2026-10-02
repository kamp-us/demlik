import { type BoundaryRepo, boundaryRepo } from "./boundary-repo.js";
import { shopManifests } from "./shop-workspace.js";

// A throwaway repo with one hexagonal scope, `services/api`, whose features are `orders` and
// `billing` unless the rules say otherwise. Files are written scope-relative (`src/orders/x.ts`),
// and `extra` is written repo-relative, for a library or a second scope.
export const API = "services/api";

export const at = (rel: string): string => `${API}/${rel}`;

export function apiRepo(
  files: Readonly<Record<string, string>>,
  rules: Readonly<Record<string, unknown>> = {},
  extra: Readonly<Record<string, string>> = {},
): BoundaryRepo {
  const own = Object.entries(files).map(([rel, body]) => [at(rel), body]);
  return boundaryRepo(
    ".",
    { ...shopManifests([API]), ...Object.fromEntries(own), ...extra },
    { features: { [API]: ["orders", "billing"] }, layout: { [API]: "hexagonal" }, ...rules },
  );
}
