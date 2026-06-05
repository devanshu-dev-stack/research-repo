import { PrismaClient, Persona } from "@prisma/client";
import { TAXONOMY, type StageSeed } from "./taxonomy";

const prisma = new PrismaClient();

/**
 * Optional embedding hook. If an embeddings provider is configured we embed
 * each stage's `seed` text so the classifier works immediately. Without keys,
 * the seed still runs and stages are inserted with NULL embeddings — you can
 * backfill later with `pnpm --filter @research-repo/db embed:stages`.
 *
 * Kept dependency-free here; wire to packages/ai's AIProvider in the app.
 */
async function embed(text: string): Promise<number[] | null> {
  if (!process.env.OPENAI_API_KEY || process.env.SEED_EMBEDDINGS === "false") {
    return null;
  }
  const dim = Number(process.env.EMBED_DIM ?? 3072);
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.EMBED_MODEL ?? "text-embedding-3-large",
      input: text,
      dimensions: dim,
    }),
  });
  if (!res.ok) {
    console.warn(`  ! embed failed (${res.status}); inserting NULL embedding`);
    return null;
  }
  const json = (await res.json()) as { data: { embedding: number[] }[] };
  return json.data[0].embedding;
}

async function insertStage(node: StageSeed, parentId: string | null, position: number) {
  // Prisma's compound-unique `where` can't match on a NULL parentId, so root
  // stages use findFirst + create/update; nested stages use the upsert path.
  let stage;
  if (parentId === null) {
    const existing = await prisma.flowStage.findFirst({
      where: { parentId: null, slug: node.slug },
    });
    stage = existing
      ? await prisma.flowStage.update({
          where: { id: existing.id },
          data: { name: node.name, description: node.seed, persona: node.persona as Persona, position },
        })
      : await prisma.flowStage.create({
          data: { parentId: null, name: node.name, slug: node.slug, description: node.seed, persona: node.persona as Persona, position },
        });
  } else {
    stage = await prisma.flowStage.upsert({
      where: { parentId_slug: { parentId, slug: node.slug } },
      update: { name: node.name, description: node.seed, persona: node.persona as Persona, position },
      create: { parentId, name: node.name, slug: node.slug, description: node.seed, persona: node.persona as Persona, position },
    });
  }

  const vec = await embed(`${node.name}. ${node.seed}`);
  if (vec) {
    await prisma.$executeRawUnsafe(
      `UPDATE "flow_stages" SET embedding = $1::vector WHERE id = $2::uuid`,
      `[${vec.join(",")}]`,
      stage.id,
    );
    console.log(`  ✓ ${node.name} (embedded)`);
  } else {
    console.log(`  ✓ ${node.name}`);
  }

  if (node.children) {
    let i = 0;
    for (const child of node.children) {
      await insertStage(child, stage.id, i++);
    }
  }
}

async function main() {
  console.log("Seeding default project…");
  await prisma.project.upsert({
    where: { slug: "collage-research" },
    update: {},
    create: {
      name: "Collage AI — Research",
      slug: "collage-research",
      description: "Default repository for Collage AI product research.",
    },
  });

  console.log("Seeding flow taxonomy (Student + Faculty)…");
  let i = 0;
  for (const node of TAXONOMY) {
    await insertStage(node, null, i++);
  }

  const count = await prisma.flowStage.count();
  console.log(`Done. ${count} flow stages in place.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
