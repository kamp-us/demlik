export const runtime = "nodejs";
export const maxDuration = 30;
export const fetchCache = "force-no-store";
export const preferredRegion = "auto";

export async function GET(): Promise<number> {
  return 200;
}

export const POST = async (): Promise<number> => 201;

async function write(): Promise<number> {
  return 204;
}

export { write as PUT, write as PATCH, write as DELETE };

export function HEAD(): number {
  return 200;
}

export function OPTIONS(): number {
  return 204;
}

export function unlistedRouteHelper(): number {
  return 0;
}
