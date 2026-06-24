import { createSqliteStorage } from "../server/sqliteStorage.ts";
import { SqlStore } from "../server/sqlStore.ts";
import { runStoreContract } from "./storeContract.ts";

// Runs the shared store contract against SqlStore on node:sqlite (:memory:) —
// the same adapter the local server uses on disk, so the contract exercises the
// real Node SQLite path rather than a bespoke shim.
runStoreContract("SqlStore", () => new SqlStore(createSqliteStorage()));
