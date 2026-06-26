import { cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

// One-time migration: the default data location moved from the package dir
// (`<root>/data/`) to a user-owned home dir (`~/.sideshow/`). Existing installs
// may have their SQLite db and/or legacy JSON file under the old path. This
// copies those files to the new location before the store opens, so an upgrade
// preserves data without a manual move.
//
// It's a no-op if the old dir doesn't exist or has no sideshow files, and it
// never overwrites files already present at the new location (idempotent —
// safe to call on every boot). The old files are left in place as a backup
// (rename on the same filesystem moves them; a cross-device copy leaves the
// original behind). Only the four sideshow data files are touched — anything
// else in the old dir stays put.
export function migrateLegacyDataDir(oldDir: string, newDir: string): boolean {
  if (!existsSync(oldDir)) return false;
  const names = ["sideshow.json", "sideshow.db", "sideshow.db-wal", "sideshow.db-shm"];
  if (!names.some((n) => existsSync(join(oldDir, n)))) return false;
  mkdirSync(newDir, { recursive: true });
  let moved = false;
  for (const name of names) {
    const src = join(oldDir, name);
    if (!existsSync(src)) continue;
    const dst = join(newDir, name);
    if (existsSync(dst)) continue; // idempotent — never overwrite
    try {
      renameSync(src, dst); // atomic + fast on the same filesystem
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      cpSync(src, dst); // cross-device: copy, leave original as backup
    }
    moved = true;
  }
  return moved;
}
