process.env.PATH = [
  process.env.PATH,
  "/nix/store",
  "/run/current-system/sw/bin",
]
  .filter(Boolean)
  .join(":");

console.log("PATH at startup:", process.env.PATH);

import app from "./app";
import { logger } from "./lib/logger";
import {
  checkDependencies,
  logDependencyReport,
} from "./services/dependencyCheck";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Probe binary dependencies at startup so missing tools surface clearly.
// This log is the authoritative PATH seen by the Node process.
checkDependencies()
  .then((report) => {
    console.log("[deps.report]", JSON.stringify(report, null, 2));
    logDependencyReport(report);
  })
  .catch((err) => {
    console.error(
      "[deps.check_failed]",
      err instanceof Error ? err.message : String(err),
    );
  });

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
