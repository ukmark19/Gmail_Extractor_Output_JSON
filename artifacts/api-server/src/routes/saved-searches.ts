import { Router, type IRouter } from "express";
import { db, savedSearchesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { CreateSavedSearchBody, DeleteSavedSearchParams } from "@workspace/api-zod";

const router: IRouter = Router();

async function requireAuth(req: { session: unknown }, res: { status: (n: number) => { json: (d: unknown) => void } }, next: () => void): Promise<void> {
  const session = req.session as { userId?: number };
  if (!session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

// GET /api/saved-searches
router.get("/saved-searches", requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>, async (req, res): Promise<void> => {
  const session = req.session as { userId?: number };

  const searches = await db
    .select()
    .from(savedSearchesTable)
    .where(eq(savedSearchesTable.userId, session.userId!))
    .orderBy(savedSearchesTable.createdAt);

  res.json({
    savedSearches: searches.map((s) => ({
      id: s.id,
      name: s.name,
      query: s.query,
      fields: s.fields,
      createdAt: s.createdAt.toISOString(),
    })),
  });
});

// POST /api/saved-searches
router.post("/saved-searches", requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>, async (req, res): Promise<void> => {
  const session = req.session as { userId?: number };

  const parsed = CreateSavedSearchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [saved] = await db
    .insert(savedSearchesTable)
    .values({
      userId: session.userId!,
      name: parsed.data.name,
      query: parsed.data.query,
      fields: parsed.data.fields || null,
    })
    .returning();

  res.status(201).json({
    id: saved.id,
    name: saved.name,
    query: saved.query,
    fields: saved.fields,
    createdAt: saved.createdAt.toISOString(),
  });
});

// DELETE /api/saved-searches/:id
router.delete("/saved-searches/:id", requireAuth as unknown as (req: unknown, res: unknown, next: () => void) => Promise<void>, async (req, res): Promise<void> => {
  const session = req.session as { userId?: number };

  const paramsParsed = DeleteSavedSearchParams.safeParse(req.params);
  if (!paramsParsed.success) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const [deleted] = await db
    .delete(savedSearchesTable)
    .where(
      and(
        eq(savedSearchesTable.id, paramsParsed.data.id),
        eq(savedSearchesTable.userId, session.userId!)
      )
    )
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Saved search not found" });
    return;
  }

  res.json({ success: true });
});

export default router;
