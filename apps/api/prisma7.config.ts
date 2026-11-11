import { config } from "dotenv";
import { defineConfig } from "prisma/config";

config({ path: "../../.env" });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // The CLI (migrate) needs a direct connection; a pooled one, like Neon's default, can't
    // hold migrate's advisory lock. The app itself connects with DATABASE_URL.
    url: process.env["DIRECT_DATABASE_URL"] || process.env["DATABASE_URL"],
  },
});
