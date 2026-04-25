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

// Probe binary dependencies at startup so missing tools surface as environment_error
// rather than being misreported as document failures.
checkDependencies()
  .then(logDependencyReport)
  .catch((err) =>
    console.error("[deps.check_failed]", err instanceof Error ? err.message : err),
  );

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
