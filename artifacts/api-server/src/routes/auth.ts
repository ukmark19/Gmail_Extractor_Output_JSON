import { Router, type IRouter } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createOAuth2Client, getAuthUrl } from "../lib/gmail";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// GET /api/auth/google — redirect to Google OAuth
router.get("/auth/google", (_req, res): void => {
  try {
    const oauth2Client = createOAuth2Client();
    const authUrl = getAuthUrl(oauth2Client);
    res.redirect(authUrl);
  } catch (err) {
    logger.error({ err }, "Failed to create OAuth URL");
    res.redirect("/?error=oauth_config_missing");
  }
});

// GET /api/auth/google/callback — OAuth callback
router.get("/auth/google/callback", async (req, res): Promise<void> => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;

  if (error) {
    req.log.warn({ error }, "OAuth error from Google");
    res.redirect(`/?error=${error}`);
    return;
  }

  if (!code) {
    res.redirect("/?error=missing_code");
    return;
  }

  try {
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.access_token) {
      res.redirect("/?error=no_access_token");
      return;
    }

    oauth2Client.setCredentials(tokens);

    // Get user info from Google
    const { google } = await import("googleapis");
    const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
    const { data: userInfo } = await oauth2.userinfo.get();

    if (!userInfo.id || !userInfo.email) {
      res.redirect("/?error=missing_user_info");
      return;
    }

    // Upsert user in DB
    const tokenExpiry = tokens.expiry_date ? new Date(tokens.expiry_date) : null;

    const [user] = await db
      .insert(usersTable)
      .values({
        googleId: userInfo.id,
        email: userInfo.email,
        name: userInfo.name || null,
        picture: userInfo.picture || null,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || null,
        tokenExpiry,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: usersTable.googleId,
        set: {
          email: userInfo.email,
          name: userInfo.name || null,
          picture: userInfo.picture || null,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || null,
          tokenExpiry,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!user) {
      res.redirect("/?error=db_error");
      return;
    }

    // Store user ID in session
    (req.session as { userId?: number }).userId = user.id;

    req.log.info({ userId: user.id, email: user.email }, "User authenticated");
    res.redirect("/search");
  } catch (err) {
    req.log.error({ err }, "OAuth callback error");
    res.redirect("/?error=auth_failed");
  }
});

// GET /api/auth/me — get current user
router.get("/auth/me", async (req, res): Promise<void> => {
  const session = req.session as { userId?: number };
  if (!session.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, session.userId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    res.json({
      id: user.googleId,
      email: user.email,
      name: user.name,
      picture: user.picture,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching user");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/auth/logout
router.post("/auth/logout", (req, res): void => {
  req.session.destroy((err) => {
    if (err) {
      req.log.error({ err }, "Error destroying session");
    }
  });
  res.json({ success: true });
});

export default router;
