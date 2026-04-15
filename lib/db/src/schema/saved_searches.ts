import { pgTable, text, integer, timestamp, serial, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const savedSearchesTable = pgTable("saved_searches", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  query: text("query").notNull(),
  fields: jsonb("fields"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type SavedSearch = typeof savedSearchesTable.$inferSelect;
export type InsertSavedSearch = typeof savedSearchesTable.$inferInsert;
