const SPEAKER_EXPORT_FIELDS = ["id", "label", "name", "voice", "style"] as const;
const LINE_EXPORT_HEADERS = ["id", "order", "speaker", "speakerLabel", "transcript", "text", "voice", "style", "notes", "status", "model", "responseFormat", "promptProfileId", "directorProfileId", "generationStatus"];

export function sanitizeLinesForExport(
  lines: Array<{
    id: string;
    lineId?: string | null;
    order: number;
    speaker: string;
    text: string;
    voice: string;
    style: string | null;
    notes: string | null;
    status: string;
    directorProfileId: string | null;
    generationStatus: string | null;
  }>,
  artifactLinesById: Map<string, Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return lines.map((l) => {
    const lineId = l.lineId ?? l.id;
    const artifactLine = artifactLinesById.get(lineId) ?? {};
    return {
      id: lineId,
      order: l.order,
      speaker: l.speaker,
      speakerLabel: typeof artifactLine.speakerLabel === "string" ? artifactLine.speakerLabel : null,
      transcript: typeof artifactLine.transcript === "string" ? artifactLine.transcript : l.text,
      text: l.text,
      voice: l.voice,
      style: l.style,
      notes: l.notes,
      status: l.status,
      model: typeof artifactLine.model === "string" ? artifactLine.model : "google/gemini-3.1-flash-tts-preview",
      responseFormat: artifactLine.responseFormat === "pcm" || artifactLine.responseFormat === "mp3" || artifactLine.responseFormat === "wav" ? artifactLine.responseFormat : "wav",
      promptProfileId: typeof artifactLine.promptProfileId === "string" ? artifactLine.promptProfileId : (l.directorProfileId ?? null),
      directorProfileId: l.directorProfileId ?? (typeof artifactLine.promptProfileId === "string" ? artifactLine.promptProfileId : null),
      generationStatus: l.generationStatus ?? "draft",
    };
  });
}

export function buildProductionListExportData(
  taskId: string,
  currentVersion: number,
  speakers: Array<Record<string, unknown>>,
  sanitizedLines: Array<Record<string, unknown>>,
  promptProfiles: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  return {
    schemaVersion: "tts.production-list.v2",
    taskId,
    version: currentVersion,
    exportedAt: new Date().toISOString(),
    promptProfiles,
    directorProfiles: promptProfiles,
    speakers: speakers.map((s: Record<string, unknown>) => {
      const clean: Record<string, unknown> = {};
      for (const field of SPEAKER_EXPORT_FIELDS) {
        if (s[field] !== undefined) clean[field] = s[field];
      }
      return clean;
    }),
    lines: sanitizedLines,
  };
}

export function formatProductionListCsv(sanitizedLines: Array<Record<string, unknown>>): string {
  const csvRows = [LINE_EXPORT_HEADERS.join(",")];
  for (const line of sanitizedLines) {
    csvRows.push(LINE_EXPORT_HEADERS.map((h) => {
      const val = line[h];
      if (val === null || val === undefined) return "";
      const strVal = String(val);
      if (strVal.includes(",") || strVal.includes('"') || strVal.includes("\n")) {
        return `"${strVal.replace(/"/g, '""')}"`;
      }
      return strVal;
    }).join(","));
  }
  return csvRows.join("\n");
}

export function formatProductionListMarkdown(
  taskId: string,
  currentVersion: number,
  exportedAt: unknown,
  exportSpeakers: Array<Record<string, unknown>>,
  sanitizedLines: Array<Record<string, unknown>>,
  promptProfiles: Array<Record<string, unknown>> = [],
): string {
  let md = `# Production List v${currentVersion}\n\n`;
  md += `Task ID: ${taskId}\n`;
  md += `Exported: ${exportedAt}\n\n`;
  if (promptProfiles.length > 0) {
    md += `## Prompt Profiles\n\n`;
    for (const profile of promptProfiles) {
      md += `### ${profile.name ?? profile.id ?? "Unnamed Profile"}\n\n`;
      md += `- ID: ${profile.id ?? ""}\n`;
      md += `- Audio Profile: ${profile.audioProfile ?? ""}\n`;
      md += `- Scene: ${profile.scene ?? ""}\n`;
      md += `- Director's Notes: ${profile.directorNotes ?? ""}\n`;
      md += `- Sample Context: ${profile.sampleContext ?? ""}\n\n`;
      const boundLines = sanitizedLines.filter((line) => line.promptProfileId === profile.id || line.directorProfileId === profile.id);
      if (boundLines.length > 0) {
        md += `Bound transcripts:\n`;
        for (const line of boundLines) {
          md += `- ${line.order ?? 0}. ${String(line.transcript ?? line.text ?? "").replace(/\n/g, " ")}\n`;
        }
        md += `\n`;
      }
    }
  }
  md += `## Speakers\n\n`;
  for (const s of exportSpeakers) {
    md += `- **${s.label ?? "Unknown"}** (${s.id ?? "?"}): voice=${s.voice ?? "?"}${s.style ? `, style=${s.style}` : ""}\n`;
  }
  md += `\n## Lines (${sanitizedLines.length})\n\n`;
  md += `| # | Speaker | Text | Voice | Status |\n`;
  md += `|---|---------|------|-------|--------|\n`;
  for (const line of sanitizedLines) {
    const text = String(line.text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 100);
    md += `| ${line.order ?? 0} | ${line.speaker ?? ""} | ${text} | ${line.voice ?? ""} | ${line.status ?? ""} |\n`;
  }
  return md;
}
