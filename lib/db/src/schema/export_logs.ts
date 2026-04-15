import { pgTable, text, integer, timestamp, serial } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const exportLogsTable = pgTable("export_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  exportId: text("export_id").notNull(),
  format: text("format").notNull(),
  count: integer("count").notNull(),
  queryUsed: text("query_used"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ExportLog = typeof exportLogsTable.$inferSelect;
export type InsertExportLog = typeof exportLogsTable.$inferInsert;
