/// <reference path="./types/pdf-parse.d.ts" />
// Extraction adapters that feed `normalize`. Each capability is provider-
// selected via env, with a no-op/stub fallback so the pipeline never hard-fails
// when a provider isn't configured (the source becomes `partial`, not `failed`).

import { spawn } from "node:child_process";
import type { ChunkInput } from "@research-repo/core";

export interface ExtractResult {
  content: string;
  units: ChunkInput[]; // carry timing (ms) / page / bbox / response_ref
  language?: string;
}

// ── Transcription (audio/video) ───────────────────────────
export interface Transcriber {
  transcribe(fileUrl: string, bytes: Buffer, mime?: string): Promise<ExtractResult>;
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

// Gemini transcription. Audio/video is multimodal-native to gemini-2.5-*, so a
// single API key handles transcription too. We DON'T send the raw video — frames
// would cost enormous tokens. Instead ffmpeg streams just the audio track (mono
// 16kHz mp3) straight from the storage URL, which we upload via the File API and
// transcribe with timestamps for clip-level traceability.
const GEMINI_BASE = "https://generativelanguage.googleapis.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GeminiTranscriber implements Transcriber {
  private model =
    process.env.GEMINI_TRANSCRIBE_MODEL || process.env.LLM_MODEL || "gemini-2.5-flash-lite";
  constructor(private apiKey = process.env.GEMINI_API_KEY) {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY not set");
  }

  async transcribe(fileUrl: string, _bytes: Buffer, _mime?: string): Promise<ExtractResult> {
    const audio = await extractAudioMp3(fileUrl);
    if (audio.length === 0) return { content: "", units: [] };
    const fileUri = await this.uploadFile(audio, "audio/mpeg");
    const prompt =
      "Transcribe this recording verbatim in English. Prefix each speaker turn " +
      "(or roughly every 30 seconds) with a timestamp marker like [MM:SS]. Label " +
      "distinguishable speakers as 'Speaker 1:', 'Speaker 2:', etc. Output ONLY the " +
      "transcript text — no preamble, summary, or commentary.";
    const text = await this.generate(fileUri, "audio/mpeg", prompt);
    return parseTimestampedTranscript(text);
  }

  // Resumable File API upload → returns the file URI once the file is ACTIVE.
  private async uploadFile(bytes: Buffer, mime: string): Promise<string> {
    const start = await fetch(`${GEMINI_BASE}/upload/v1beta/files`, {
      method: "POST",
      headers: {
        "x-goog-api-key": this.apiKey!,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(bytes.length),
        "X-Goog-Upload-Header-Content-Type": mime,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: "transcription-audio" } }),
    });
    if (!start.ok) throw new Error(`Gemini file start ${start.status}: ${await start.text()}`);
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("Gemini file upload URL missing from start response");

    const up = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Command": "upload, finalize",
        "X-Goog-Upload-Offset": "0",
        "Content-Length": String(bytes.length),
      },
      body: bytes as unknown as BodyInit,
    });
    if (!up.ok) throw new Error(`Gemini file upload ${up.status}: ${await up.text()}`);
    let file = ((await up.json()) as any).file as { name: string; uri: string; state: string };

    // Audio/video files process asynchronously; poll until ACTIVE.
    for (let i = 0; file.state === "PROCESSING" && i < 90; i++) {
      await sleep(2000);
      const poll = await fetch(`${GEMINI_BASE}/v1beta/${file.name}`, {
        headers: { "x-goog-api-key": this.apiKey! },
      });
      file = (await poll.json()) as any;
    }
    if (file.state !== "ACTIVE") throw new Error(`Gemini file not ready (state=${file.state})`);
    return file.uri;
  }

  private async generate(fileUri: string, mime: string, prompt: string): Promise<string> {
    const res = await fetch(`${GEMINI_BASE}/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": this.apiKey!, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ file_data: { mime_type: mime, file_uri: fileUri } }, { text: prompt }],
          },
        ],
        generationConfig: { maxOutputTokens: 32768, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });
    if (!res.ok) throw new Error(`Gemini transcribe ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as any;
    return (
      data.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? ""
    );
  }
}

/** Stream the audio track out of an audio/video URL as mono 16kHz mp3 (small).
 *  ffmpeg reads the URL directly so we never buffer the full media file. */
function extractAudioMp3(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", url,
      "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k",
      "-f", "mp3", "pipe:1",
    ]);
    const out: Buffer[] = [];
    let err = "";
    ff.stdout.on("data", (c) => out.push(c));
    ff.stderr.on("data", (c) => (err += c.toString()));
    ff.on("error", (e) => reject(new Error(`ffmpeg spawn failed: ${e.message}`)));
    ff.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 400)}`));
    });
  });
}

/** Turn a transcript with [MM:SS] / [HH:MM:SS] markers into timed units +
 *  marker-free content. The model timestamps almost every short utterance, so we
 *  COALESCE consecutive segments into ~chunk-sized units (preserving the time
 *  span) — otherwise each utterance becomes its own chunk and a 1-hour recording
 *  explodes into thousands of tiny chunks. Falls back to one untimed unit if no
 *  markers are present. */
export function parseTimestampedTranscript(text: string): ExtractResult {
  const clean = text.trim();
  if (!clean) return { content: "", units: [] };
  const markPattern = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g;
  const marks: { idx: number; ms: number }[] = [];
  for (let m = markPattern.exec(clean); m; m = markPattern.exec(clean)) {
    const h = m[3] != null ? Number(m[1]) : 0;
    const min = m[3] != null ? Number(m[2]) : Number(m[1]);
    const sec = m[3] != null ? Number(m[3]) : Number(m[2]);
    marks.push({ idx: m.index, ms: (h * 3600 + min * 60 + sec) * 1000 });
  }
  const strip = (s: string) => s.replace(/\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/g, "").trim();
  const stripped = strip(clean).replace(/\n{3,}/g, "\n\n").trim();
  if (marks.length === 0) return { content: stripped, units: [{ text: stripped }] };

  // Pack segments into ~CHUNK_TOKENS-sized units so downstream chunking is sane.
  const maxChars = Number(process.env.CHUNK_TOKENS ?? 400) * 4;
  const units: ChunkInput[] = [];
  let buf = "";
  let bufStart: number | null = null;
  let bufEnd: number | null = null;
  for (let i = 0; i < marks.length; i++) {
    const seg = strip(clean.slice(marks[i].idx, i + 1 < marks.length ? marks[i + 1].idx : clean.length));
    if (!seg) continue;
    if (buf && buf.length + seg.length + 1 > maxChars) {
      units.push({ text: buf, startMs: bufStart, endMs: bufEnd });
      buf = "";
      bufStart = null;
    }
    if (bufStart == null) bufStart = marks[i].ms;
    bufEnd = i + 1 < marks.length ? marks[i + 1].ms : marks[i].ms;
    buf = buf ? `${buf} ${seg}` : seg;
  }
  if (buf) units.push({ text: buf, startMs: bufStart, endMs: bufEnd });
  return { content: stripped, units };
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
