import { prisma } from "@research-repo/db";
import { hasGeminiKey } from "@research-repo/ai";
import { presignGet, getObjectBytes } from "../storage";
import {
  DeepgramTranscriber,
  GeminiTranscriber,
  LocalDocExtractor,
  NoopExtract,
  TesseractOCR,
  type DocExtractor,
  type ExtractResult,
  type OCREngine,
  type Transcriber,
} from "../extractors";

// Provider selection (env), with resilient no-op fallbacks. When a Gemini key
// is present, transcription defaults to Gemini so audio/video "just works".
function transcriber(): Transcriber {
  const def = hasGeminiKey() ? "gemini" : "noop";
  const c = (process.env.TRANSCRIBE_PROVIDER || def).toLowerCase();
  if (c === "deepgram" && process.env.DEEPGRAM_API_KEY) return new DeepgramTranscriber();
  if (c === "gemini" && hasGeminiKey()) return new GeminiTranscriber();
  return new NoopExtract();
}
function ocr(): OCREngine {
  const c = (process.env.OCR_PROVIDER ?? "tesseract").toLowerCase();
  if (c === "tesseract") return new TesseractOCR();
  return new NoopExtract();
}
function docExtractor(): DocExtractor {
  const c = (process.env.DOC_PROVIDER ?? "local").toLowerCase();
  if (c === "local") return new LocalDocExtractor();
  return new NoopExtract();
}

/**
 * Stage: extract (runs BEFORE normalize). Turns binary media into text +
 * traceable units, stashing them on source.metadata for normalize to
 * canonicalize. Text formats (note/transcript/survey) skip extraction —
 * normalize handles them directly. Idempotent: only writes scalar metadata.
 *
 * Returns nothing meaningful for text types; for media, it populates
 * metadata._extracted = { content, units }.
 */
export async function runExtract(sourceId: string): Promise<void> {
  const source = await prisma.source.findUniqueOrThrow({ where: { id: sourceId } });

  // Text formats are normalized directly; nothing to extract.
  if (["note", "transcript", "survey"].includes(source.sourceType)) return;

  let result: ExtractResult = { content: "", units: [] };

  switch (source.sourceType) {
    case "audio":
    case "video": {
      const t = transcriber();
      const url = await presignGet(source.storageKey);
      // Gemini streams the audio track from the URL via ffmpeg (no full-file
      // buffer — important for large videos); Deepgram needs the raw bytes.
      const bytes =
        t instanceof DeepgramTranscriber ? await getObjectBytes(source.storageKey) : Buffer.alloc(0);
      result = await t.transcribe(url, bytes, source.mimeType ?? undefined);
      break;
    }
    case "image":
      result = await ocr().ocr(await getObjectBytes(source.storageKey));
      break;
    case "pdf":
    case "doc":
      result = await docExtractor().extract(await getObjectBytes(source.storageKey), source.mimeType);
      break;
    default:
      return; // 'other' — leave for manual handling
  }

  await prisma.source.update({
    where: { id: sourceId },
    data: {
      transcript: source.sourceType === "audio" || source.sourceType === "video" ? result.content : source.transcript,
      language: result.language ?? source.language,
      metadata: {
        ...(source.metadata as object),
        _extracted: { content: result.content, units: result.units },
      } as any,
    },
  });
}
