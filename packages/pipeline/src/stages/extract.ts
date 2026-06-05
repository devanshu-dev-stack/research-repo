import { prisma } from "@research-repo/db";
import { presignGet, getObjectBytes } from "../storage";
import {
  DeepgramTranscriber,
  LocalDocExtractor,
  NoopExtract,
  TesseractOCR,
  type DocExtractor,
  type ExtractResult,
  type OCREngine,
  type Transcriber,
} from "../extractors";

// Provider selection (env), with resilient no-op fallbacks.
function transcriber(): Transcriber {
  const c = (process.env.TRANSCRIBE_PROVIDER ?? "noop").toLowerCase();
  if (c === "deepgram" && process.env.DEEPGRAM_API_KEY) return new DeepgramTranscriber();
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
  const bytes = await getObjectBytes(source.storageKey);

  switch (source.sourceType) {
    case "audio":
    case "video": {
      const url = await presignGet(source.storageKey);
      result = await transcriber().transcribe(url, bytes);
      break;
    }
    case "image":
      result = await ocr().ocr(bytes);
      break;
    case "pdf":
    case "doc":
      result = await docExtractor().extract(bytes, source.mimeType);
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
