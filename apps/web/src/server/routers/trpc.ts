import { initTRPC } from "@trpc/server";
import superjson from "superjson";

// superjson so BigInt (e.g. sources.byteSize) and Date round-trip correctly.
// Must match the client transformer in apps/web/src/lib/trpc.tsx.
const t = initTRPC.create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;
