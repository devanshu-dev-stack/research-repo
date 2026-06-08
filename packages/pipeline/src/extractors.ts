/// <reference path="./types/pdf-parse.d.ts" />
// Extraction adapters that feed `normalize`. Each capability is provider-
// selected via env, with a no-op/stub fallback so the pipeline never hard-fails
// when a provider isn't configured (the source becomes `partial`, not `failed`).

import type { ChunkInput } from "@research-repo/core";

export interface ExtractResult {
  content: string;
  units: ChunkInput[]; // carry timing (ms) / page / bbox / response_ref
  language?: string;
}

// ── Transcription (audio/video) ───────────────────────────
export interface Transcriber {
  transcribe(fileUrl: string, bytes: Buffer): Promise<ExtractResult>;
}

export class DeepgramTranscriber implements Transcriber {
  constructor(private apiKey = process.env.DEEPGRAM_API_KEY) {
    if (!this.apiKey) throw new Error("DEEPGRAM_API_KEY not set");
  }
  async transcribe(_fileUrl: string, bytes: Buffer): Promise<ExtractResult> {
    const res = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true",
      {
        method: "POST",
        headers: { Authorization: `Token ${this.apiKey}` },
        body: bytes as unknown as BodyInit,
      },
    );
    if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
    const json = (await res.json()) as any;
    const alt = json?.results?.channels?.[0]?.alternatives?.[0];
    const transcript: string = alt?.transcript ?? "";
    // One unit per utterance, with ms timings for clip-level traceability.
    const utterances = json?.results?.utterances ?? [];
    const units: ChunkInput[] = utterances.length
      ? utterances.map((u: any) => ({
          text: u.transcript,
          startMs: Math.round((u.start ?? 0) * 1000),
          endMs: Math.round((u.end ?? 0) * 1000),
        }))
      : transcript
        ? [{ text: transcript }]
        : [];
    return { content: transcript, units };
  }
}

// ── OCR (images) ──────────────────────────────────────────
export interface OCREngine {
  ocr(bytes: Buffer): Promise<ExtractResult>;
}

// Tesseract via the `tesseract.js` package (pure JS; no system binary).
export class TesseractOCR implements OCREngine {
  async ocr(bytes: Buffer): Promise<ExtractResult> {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      const { data } = await worker.recognize(bytes);
      const units: ChunkInput[] = (data.words ?? [])
        .filter((w: any) => w.text?.trim())
        .map((w: any) => ({
          text: w.text,
          bbox: w.bbox
            ? { x: w.bbox.x0, y: w.bbox.y0, w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0 }
            : undefined,
        })) as ChunkInput[];
      // Group into a single content blob; keep word bboxes as units fallback.
      return {
        content: data.text ?? "",
        units: data.text ? [{ text: data.text }] : units,
      };
    } finally {
      await worker.terminate();
    }
  }
}

// ── Document text (pdf/doc) ───────────────────────────────
export interface DocExtractor {
  extract(bytes: Buffer, mime: string | null): Promise<ExtractResult>;
}

export class LocalDocExtractor implements DocExtractor {
  async extract(bytes: Buffer, mime: string | null): Promise<ExtractResult> {
    if (mime === "application/pdf" || isPdf(bytes)) {
      const { default: pdfParse } = await import("pdf-parse");
      const parsed = await pdfParse(bytes);
      // pdf-parse gives full text; page-level units use form-feed splits.
      const pages = parsed.text.split("\f").filter((p) => p.trim());
      const units: ChunkInput[] = pages.length
        ? pages.map((text, i) => ({ text, page: i + 1 }))
        : [{ text: parsed.text }];
      return { content: parsed.text, units };
    }
    // docx → mammoth (raw text)
    const { extractRawText } = await import("mammoth");
    const result = await extractRawText({ buffer: bytes });
    return { content: result.value, units: [{ text: result.value }] };
  }
}

function isPdf(b: Buffer): boolean {
  return b.length > 4 && b.toString("ascii", 0, 5) === "%PDF-";
}

// ── No-op fallbacks (keep pipeline resilient when unconfigured) ────────────
export class NoopExtract implements Transcriber, OCREngine, DocExtractor {
  async transcribe(): Promise<ExtractResult> {
    return { content: "", units: [] };
  }
  async ocr(): Promise<ExtractResult> {
    return { content: "", units: [] };
  }
  async extract(): Promise<ExtractResult> {
    return { content: "", units: [] };
  }
}
