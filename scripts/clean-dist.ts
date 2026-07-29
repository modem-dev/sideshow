#!/usr/bin/env node

// Removes the tsc output tree before a package build. TypeScript only writes
// files, it never deletes output for sources that were renamed or removed, so a
// long-lived checkout accumulates stale modules that `npm pack` happily ships
// (and the "./*" export makes importable). The vite builds already self-clean
// via emptyOutDir, so this is the one output tree that needed it.
//
// Anchored to the package root rather than the process CWD so it cannot delete
// a `dist` belonging to whatever directory the script was invoked from.

import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
