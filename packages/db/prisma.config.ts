import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma 7 moved the connection URL out of schema.prisma into this config.
// Migrate/Studio read `datasource.url` from here; PrismaClient gets its
// connection at runtime via the adapter (see src/client.ts).
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
