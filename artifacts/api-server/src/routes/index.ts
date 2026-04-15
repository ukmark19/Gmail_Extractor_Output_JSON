import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import gmailRouter from "./gmail";
import exportRouter from "./export";
import savedSearchesRouter from "./saved-searches";
import exportLogsRouter from "./export-logs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(gmailRouter);
router.use(exportRouter);
router.use(savedSearchesRouter);
router.use(exportLogsRouter);

export default router;
