process.env.PATH = [
  process.env.PATH,
  "/nix/store",
  "/run/current-system/sw/bin",
]
  .filter(Boolean)
  .join(":");

console.log("PATH at startup:", process.env.PATH);

import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import app from "./app";
import { logger } from "./lib/logger";
import {
  checkDependencies,
  logDependencyReport,
} from "./services/dependencyCheck";
import { ATTACHMENT_EXTRACTOR_BUILD_MARKER } from "./lib/attachment-extractor";

// Build/runtime provenance log so we can definitively answer
// "is the running server actually serving the latest source?"
// when an export still surfaces a string we believed was fixed.
function logBuildInfo(): void {
  let gitCommit: string | null = null;
  try {
    gitCommit = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
      .toString()
      .trim();
  } catch {
    gitCommit = process.env.GIT_COMMIT ?? null;
  }
  let bundleMtime: string | null = null;
  let bundlePath: string | null = null;
  try {
    // import.meta.url points at the running bundle (dist/index.mjs in
    // production, or src/index.ts under tsx — either way, mtime tells
    // us when the bundle the process is actually executing was emitted).
    bundlePath = fileURLToPath(import.meta.url);
    bundleMtime = statSync(bundlePath).mtime.toISOString();
  } catch {
    /* ignore */
  }
  console.log("[build.info]", {
    git_commit: gitCommit,
    bundle_path: bundlePath,
    bundle_mtime: bundleMtime,
    process_started_at: new Date().toISOString(),
    source_marker: ATTACHMENT_EXTRACTOR_BUILD_MARKER,
    node_version: process.version,
  });
}

logBuildInfo();

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
