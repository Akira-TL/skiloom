import { join, resolve } from "node:path";

export type SkiloomHomePaths = Readonly<{
  userHome: string;
  homeRoot: string;
  registryPath: string;
  operationLockPath: string;
  storePath: string;
  backupsPath: string;
}>;

export function resolveSkiloomHomePaths(userHome: string): SkiloomHomePaths {
  const canonicalUserHome = resolve(userHome);
  const homeRoot = join(canonicalUserHome, ".skiloom");

  return {
    userHome: canonicalUserHome,
    homeRoot,
    registryPath: join(homeRoot, "registry.sqlite3"),
    operationLockPath: join(homeRoot, "operation.lock"),
    storePath: join(homeRoot, "store"),
    backupsPath: join(homeRoot, "backups")
  };
}
