// Node/npm loader; Photon owns its adjacent WASM asset.
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | undefined;
export function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
  return loadPromise ??= import("@silvia-odwyer/photon-node").catch(() => null);
}
