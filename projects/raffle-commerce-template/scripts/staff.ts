import { PrismaClient } from "@prisma/client";
import { z } from "zod";

const prisma = new PrismaClient();
const slug = z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (process.argv[2] !== "list") {
    throw new Error("Usage: npm run staff:list -- --tenant <tenant-slug>");
  }
  const tenantSlug = slug.parse(option("--tenant"));
  const tenant = await prisma.tenant.findFirst({
    where: { slug: tenantSlug, status: "ACTIVE" },
    select: {
      slug: true,
      users: {
        where: {
          status: "ACTIVE",
          role: { in: ["ADMIN", "COMPLIANCE", "OPERATIONS", "SUPPORT", "STAFF"] },
        },
        select: { id: true, name: true, email: true, role: true },
        orderBy: [{ role: "asc" }, { email: "asc" }],
      },
    },
  });
  if (!tenant) throw new Error(`Active tenant '${tenantSlug}' not found`);
  console.log(JSON.stringify({ tenant: tenant.slug, staff: tenant.users }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
