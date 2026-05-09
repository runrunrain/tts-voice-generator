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

  // Fetch page of records with the latest audio asset for each job.
  // Uses a correlated subquery to get the most recent audio_asset per job.
  const offset = (page - 1) * pageSize;
  const rows = db
    .select({
      job: generationJob,
      assetId: audioAsset.id,
      assetFilePath: audioAsset.filePath,
      assetMimeType: audioAsset.mimeType,
      assetSizeBytes: audioAsset.sizeBytes,
      assetDuration: audioAsset.duration,
      assetSampleRate: audioAsset.sampleRate,
      assetBitDepth: audioAsset.bitDepth,
      assetChannels: audioAsset.channels,
      assetCreatedAt: audioAsset.createdAt,
    })
    .from(generationJob)
    .leftJoin(
      audioAsset,
      and(
        eq(audioAsset.jobId, generationJob.id),
        // Pick the latest asset for each job via correlated subquery condition.
        // Since SQLite doesn't easily support LEFT JOIN LATERAL, we filter to
        // the max-id asset per job using a subquery in the ON clause.
        eq(
          audioAsset.id,
          sql<number>`(
            SELECT a2.id FROM audio_asset a2
            WHERE a2.job_id = generation_job.id
            ORDER BY a2.created_at DESC, a2.id DESC
            LIMIT 1
          )`
        ),
      ),
    )
    .where(whereClause)
    .orderBy(desc(generationJob.createdAt))
    .limit(pageSize)
    .offset(offset)
    .all();

  // Determine the base URL for audio endpoints
  const audioBase = `/api/audio`;

  // Format response to match API spec
  const formattedRecords = rows.map((row) => {
    const job = row.job;
    const hasAsset = row.assetId != null;
    return {
      id: job.id,
      textPreview: job.input.length > 100 ? job.input.slice(0, 100) + "..." : job.input,
      voice: job.voice,
      format: job.responseFormat,
      status: job.status,
      source: job.source === "user" ? "用户" : job.source === "cli" ? "CLI" : "Agent",
      charCount: job.inputCharCount,
      cost: job.estimatedCost,
      createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
      error: job.status === "failed" ? job.errorCode : undefined,
      // Audio asset fields (null when no asset exists)
      assetId: hasAsset ? row.assetId : null,
      audioUrl: hasAsset ? `${audioBase}/${row.assetId}` : null,
      downloadUrl: hasAsset ? `${audioBase}/${row.assetId}?download=1` : null,
      durationMs: hasAsset && row.assetDuration ? parseDurationMs(row.assetDuration) : null,
      assetFormat: hasAsset ? formatFromMime(row.assetMimeType) : null,
      sizeBytes: hasAsset ? row.assetSizeBytes : null,
      sampleRate: hasAsset ? row.assetSampleRate : null,
      bitDepth: hasAsset ? row.assetBitDepth : null,
      channels: hasAsset ? row.assetChannels : null,
      // Agent context fields (present when source is "agent")
      agentConversationId: job.agentConversationId ?? null,
      agentActionLogId: job.agentActionLogId ?? null,
    };
  });

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
      agentConversationId: job.agentConversationId ?? null,
      agentActionLogId: job.agentActionLogId ?? null,
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
      sampleRate: asset.sampleRate,
      bitDepth: asset.bitDepth,
      channels: asset.channels,
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

    // Support download mode: ?download=1 triggers Content-Disposition: attachment
    const isDownload = c.req.query("download") === "1";
    const disposition = isDownload ? "attachment" : "inline";

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Disposition": `${disposition}; filename="${asset.fileName}"`,
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a duration string like "3.2s" into milliseconds.
 * Returns null if the format is unexpected.
 */
function parseDurationMs(duration: string | null): number | null {
  if (!duration) return null;
  const match = duration.match(/^([\d.]+)s$/);
  if (!match) return null;
  return Math.round(parseFloat(match[1]) * 1000);
}

/**
 * Extract a short format label from a MIME type.
 * e.g. "audio/mpeg" -> "mp3", "audio/pcm" -> "pcm"
 */
function formatFromMime(mimeType: string | null): string | null {
  if (!mimeType) return null;
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("pcm")) return "pcm";
  return mimeType.split("/")[1] || null;
}

export default app;
