import { Router, type IRouter } from "express";
import { db, exportLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { desc } from "drizzle-orm";

const router: IRouter = Router();

async function requireAuth(req: { session: unknown }, res: { status: (n: number) => { json: (d: unknown) => void } }, next: () => void): Promise<void> {
  const session = req.session as { userId?: number };
  if (!session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

// GET /api/export-logs
router.get("/export-logs", requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>, async (req, res): Promise<void> => {
  const session = req.session as { userId?: number };

  const logs = await db
    .select()
    .from(exportLogsTable)
    .where(eq(exportLogsTable.userId, session.userId!))
    .orderBy(desc(exportLogsTable.createdAt))
    .limit(100);

  res.json({
    logs: logs.map((l) => ({
      id: l.id,
      exportId: l.exportId,
      format: l.format,
      count: l.count,
      queryUsed: l.queryUsed,
      createdAt: l.createdAt.toISOString(),
    })),
  });
});

export default router;
