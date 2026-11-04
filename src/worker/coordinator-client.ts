import type { BlobCoordinatorRpc, Env } from "./types";

export function getBlobCoordinator(
  env: Env,
  sha256: string,
): BlobCoordinatorRpc {
  const id = env.BLOB_COORDINATOR.idFromName(sha256);
  return env.BLOB_COORDINATOR.get(id) as unknown as BlobCoordinatorRpc;
}
