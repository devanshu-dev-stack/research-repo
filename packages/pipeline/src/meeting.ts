import { prisma } from "@research-repo/db";
import { getLLMProvider } from "@research-repo/ai";

/**
 * Name an untitled meeting from its processed sources' content (transcript /
 * notes / survey text). Safe to call repeatedly: it no-ops once a title exists
 * (including a user-set one), and the final write is guarded on title=null so
 * concurrent source completions don't clobber each other or an edit.
 */
export async function nameMeetingFromSources(meetingId: string): Promise<void> {
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
  if (!meeting || meeting.title) return;

  const sources = await prisma.source.findMany({
    where: { meetingId, status: { in: ["ready", "partial"] } },
    select: { originalName: true, sourceType: true, transcript: true, content: true, topic: true },
  });
  const snippets = sources
    .map((s) => (s.transcript || s.content || s.topic || "").trim().slice(0, 1500))
    .filter((t) => t.length > 0);
  if (snippets.length === 0) return; // nothing usable yet

  const llm = getLLMProvider();
  let raw = "";
  try {
    raw = (llm.title ? await llm.title(snippets) : await llm.summarize(snippets)).trim();
  } catch {
    return; // naming is best-effort; leave untitled for a later attempt
  }
  // Tidy into a short title: drop any leading list marker ("2. ", "- "), quotes,
  // keep the first sentence, and cap the length.
  let title = raw
    .replace(/^\s*[\d]+[.)]\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/^["'\s]+|["'\s]+$/g, "");
  title = (title.split(/(?<=[.!?])\s/)[0] || title).slice(0, 90).trim();
  if (!title) return;

  // Guard on title=null so we never overwrite a name set in the meantime.
  await prisma.meeting.updateMany({ where: { id: meetingId, title: null }, data: { title } });
}

/** Convenience for the worker: name the meeting a just-processed source belongs to. */
export async function nameMeetingForSource(sourceId: string): Promise<void> {
  const source = await prisma.source.findUnique({
    where: { id: sourceId },
    select: { meetingId: true },
  });
  if (source?.meetingId) await nameMeetingFromSources(source.meetingId);
}
