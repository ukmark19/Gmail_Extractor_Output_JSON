import { Router, type IRouter } from "express";
import {
  ensureDependencyReport,
  refreshDependencyReport,
} from "../services/dependencyCheck";

const router: IRouter = Router();

/**
 * GET /api/system/dependencies
 *
 * Debug endpoint that returns the live binary-dependency report plus the
 * Node process's PATH. Used to confirm that pdftoppm/tesseract/qpdf
 * resolved correctly at runtime — separate from what the shell sees,
 * since workflow commands and the shell can diverge.
 *
 * Query params:
 *   - refresh=1 → force a fresh probe instead of using the cached report.
 *
 * Intentionally unauthenticated. Returns binary versions, absolute Nix
 * store paths, and the PATH env var. No secrets are exposed.
 */
router.get("/system/dependencies", async (req, res) => {
  try {
    const shouldRefresh = req.query["refresh"] === "1";
    const report = shouldRefresh
      ? await refreshDependencyReport()
      : await ensureDependencyReport();
    res.json({
      ...report,
      runtime: {
        node_version: process.version,
        platform: process.platform,
        path_env: process.env["PATH"] ?? null,
      },
    });
  } catch (err) {
    res.status(500).json({
      error: "dependency_check_failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
