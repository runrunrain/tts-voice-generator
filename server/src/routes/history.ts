/**
 * History and Audio routes.
 * GET /api/history          - List generation jobs with pagination and filters
 * GET /api/jobs/:jobId      - Get single job detail
 * GET /api/audio/:assetId   - Stream audio file
 */

import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { generationJob, audioAsset } from "../db/schema.js";
import { eq, desc, and, sql, like, gte, lte } from "drizzle-orm";
import { readAudioFile } from "../utils/audio-fs.js";

const app = new Hono();

// ─── GET /api/history ────────────────────────────────────────────────────────

app.get("/api/history", (c) => {
  const db = getDb();

  // Parse query params
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query("pageSize") || "20", 10)));
  const voice = c.req.query("voice");
  const status = c.req.query("status");
  const source = c.req.query("source");
  const dateFrom = c.req.query("dateFrom");
  const dateTo = c.req.query("dateTo");

  // Build conditions
  const conditions = [];
  if (voice) conditions.push(eq(generationJob.voice, voice));
  if (status) conditions.push(eq(generationJob.status, status));
  if (source) conditions.push(eq(generationJob.source, source));
  if (dateFrom) {
    const fromDate = new Date(dateFrom);
    conditions.push(gte(generationJob.createdAt, fromDate));
  }
  if (dateTo) {
    const toDate = new Date(dateTo);
    conditions.push(lte(generationJob.createdAt, toDate));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Count total records
  const countResult = db
    .select({ count: sql<number>`count(*)` })
    .from(generationJob)
    .where(whereClause)
    .get();

  const totalRecords = countResult?.count || 0;
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));

  // Fetch page of records
  const offset = (page - 1) * pageSize;
  const records = db
    .select()
    .from(generationJob)
    .where(whereClause)
    .orderBy(desc(generationJob.createdAt))
    .limit(pageSize)
    .offset(offset)
    .all();

  // Format response to match API spec
  const formattedRecords = records.map((job) => ({
    id: job.id,
    textPreview: job.input.length > 100 ? job.input.slice(0, 100) + "..." : job.input,
    voice: job.voice,
    format: job.responseFormat,
    status: job.status,
    source: job.source === "user" ? "用户" : "Agent",
    duration: null as string | null, // Will join with audio_asset
    charCount: job.inputCharCount,
    cost: job.estimatedCost,
    createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
    error: job.status === "failed" ? job.errorCode : undefined,
  }));

  return c.json({
    records: formattedRecords,
    totalPages,
    currentPage: page,
    totalRecords,
  });
});

// ─── GET /api/jobs/:jobId ────────────────────────────────────────────────────

app.get("/api/jobs/:jobId", (c) => {
  const db = getDb();
  const jobId = c.req.param("jobId");

  const job = db.select().from(generationJob).where(eq(generationJob.id, jobId)).get();

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  // Get associated audio asset
  const asset = db.select().from(audioAsset).where(eq(audioAsset.jobId, jobId)).get();

  // Parse JSON fields
  let directorSnapshot = null;
  if (job.directorSnapshot) {
    try {
      directorSnapshot = JSON.parse(job.directorSnapshot);
    } catch {
      directorSnapshot = job.directorSnapshot;
    }
  }

  let errorMetadata = null;
  if (job.errorMetadata) {
    try {
      errorMetadata = JSON.parse(job.errorMetadata);
    } catch {
      errorMetadata = job.errorMetadata;
    }
  }

  let providerOptions = null;
  if (job.providerOptions) {
    try {
      providerOptions = JSON.parse(job.providerOptions);
    } catch {
      providerOptions = job.providerOptions;
    }
  }

  return c.json({
    job: {
      id: job.id,
      model: job.model,
      voice: job.voice,
      responseFormat: job.responseFormat,
      input: job.input,
      inputCharCount: job.inputCharCount,
      status: job.status,
      generationId: job.generationId,
      estimatedCost: job.estimatedCost,
      actualCost: job.actualCost,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      errorMetadata,
      source: job.source,
      directorSnapshot,
      providerOptions,
      createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
    },
    audio: asset ? {
      id: asset.id,
      audioUrl: `/api/audio/${asset.id}`,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      duration: asset.duration,
    } : null,
  });
});

// ─── GET /api/audio/:assetId ─────────────────────────────────────────────────

app.get("/api/audio/:assetId", (c) => {
  const db = getDb();
  const assetId = parseInt(c.req.param("assetId"), 10);

  if (isNaN(assetId)) {
    return c.json({ error: "Invalid asset ID" }, 400);
  }

  const asset = db.select().from(audioAsset).where(eq(audioAsset.id, assetId)).get();

  if (!asset) {
    return c.json({ error: "Audio asset not found" }, 404);
  }

  try {
    const buffer = readAudioFile(asset.filePath);

    return new Response(buffer, {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Disposition": `inline; filename="${asset.fileName}"`,
        "Content-Length": buffer.length.toString(),
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) {
      return c.json({ error: "Audio file not found on disk" }, 404);
    }
    return c.json({ error: "Failed to read audio file" }, 500);
  }
});

export default app;
