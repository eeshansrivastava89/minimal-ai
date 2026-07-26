#!/usr/bin/env node
import pc from "picocolors";
import { run } from "../src/cli.mjs";

try {
  await run(process.argv.slice(2));
} catch (error) {
  console.error(pc.red("error:"), error instanceof Error ? error.message : String(error));
  process.exit(1);
}