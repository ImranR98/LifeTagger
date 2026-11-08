import fs from "node:fs";
import { db } from "./db";
import { closeMetadata } from "./metadata";
import {
  applyMigration,
  getMigrationRows,
  getMigrationState,
  scanMigration,
  setMappings,
  type MappingInput,
} from "./migration";

const command = process.argv[2];

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  if (command === "scan") {
    const state = await scanMigration();
    print({ state, rows: getMigrationRows() });
    return;
  }
  if (command === "map") {
    const filename = process.argv[3];
    if (!filename)
      throw new Error("Usage: npm run migrate:map -- mapping.json");
    const mappings = JSON.parse(
      fs.readFileSync(filename, "utf8"),
    ) as MappingInput;
    setMappings(mappings);
    print({ state: getMigrationState(), rows: getMigrationRows() });
    return;
  }
  if (command === "apply") {
    const stripFilenames = !process.argv.includes("--no-strip");
    applyMigration({ stripFilenames });
    while (getMigrationState().running)
      await new Promise((resolve) => setTimeout(resolve, 500));
    print({ state: getMigrationState() });
    return;
  }
  console.log("Usage: tsx server/cli.ts <scan|map|apply> [file] [--no-strip]");
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    db.close();
    await closeMetadata().catch(() => undefined);
  });
