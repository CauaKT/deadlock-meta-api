-- AlterTable
ALTER TABLE "profiles" ADD COLUMN     "handle_confirmed" BOOLEAN NOT NULL DEFAULT false;

UPDATE "profiles" SET "handle_confirmed" = true WHERE "handle" IS NOT NULL;
