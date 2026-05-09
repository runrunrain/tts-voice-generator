interface QualityLine {
  id: string;
  lineId?: string | null;
  text: string;
  voice: string;
  speaker: string;
  status: string;
  directorProfileId: string | null;
  generationStatus: string | null;
}

interface QualityIssue {
  severity: string;
  code: string;
  message: string;
  lineId?: string;
}

export function buildQualityReportMetrics(
  lines: QualityLine[],
  artifactLinesById: Map<string, Record<string, unknown>>,
  directorProfileExists: (profileId: string) => boolean,
  promptProfiles: Array<Record<string, unknown>> = [],
): { metrics: Record<string, unknown>; issues: QualityIssue[] } {
  const issues: QualityIssue[] = [];
  const metrics: Record<string, unknown> = {};

  let missingTextCount = 0;
  let missingVoiceCount = 0;
  let missingSpeakerCount = 0;
  let missingDirectorCount = 0;
  let missingPromptStructureCount = 0;
  let incompletePromptProfileCount = 0;
  let missingModelCount = 0;
  const promptProfilesById = new Map(promptProfiles.map((profile) => [String(profile.id ?? ""), profile]));

  for (const line of lines) {
    const lineId = line.lineId ?? line.id;
    if (!line.text || line.text.trim().length === 0) {
      missingTextCount++;
      issues.push({ severity: "error", code: "EMPTY_TEXT", message: `Line "${lineId}" has empty text`, lineId });
    }
    if (!line.voice || line.voice.trim().length === 0) {
      missingVoiceCount++;
      issues.push({ severity: "error", code: "MISSING_VOICE", message: `Line "${lineId}" has no voice configured`, lineId });
    }
    if (!line.speaker || line.speaker.trim().length === 0) {
      missingSpeakerCount++;
      issues.push({ severity: "warning", code: "MISSING_SPEAKER", message: `Line "${lineId}" has no speaker`, lineId });
    }
    if (!line.directorProfileId) {
      missingDirectorCount++;
    }
    const artifactLine = artifactLinesById.get(lineId);
    const promptProfileId = typeof artifactLine?.promptProfileId === "string" ? artifactLine.promptProfileId : line.directorProfileId;
    if (!promptProfileId) {
      missingPromptStructureCount++;
      issues.push({ severity: "error", code: "MISSING_PROMPT_STRUCTURE", message: `Line "${lineId}" has no prompt profile binding`, lineId });
    } else {
      const profile = promptProfilesById.get(promptProfileId);
      if (profile) {
        const missingFields = ["audioProfile", "scene", "directorNotes", "sampleContext"].filter((field) => {
          const value = profile[field];
          return typeof value !== "string" || value.trim().length === 0;
        });
        if (missingFields.length > 0) {
          incompletePromptProfileCount++;
          issues.push({ severity: "error", code: "INCOMPLETE_BOUND_PROMPT_PROFILE", message: `Prompt profile "${promptProfileId}" is missing: ${missingFields.join(", ")}`, lineId });
        }
      } else if (!directorProfileExists(promptProfileId)) {
        missingPromptStructureCount++;
        issues.push({ severity: "error", code: "MISSING_PROMPT_STRUCTURE", message: `Line "${lineId}" references missing prompt profile "${promptProfileId}"`, lineId });
      }
    }
    if (!artifactLine?.model && !line.voice) {
      missingModelCount++;
    }
  }

  metrics.missingFields = {
    text: missingTextCount,
    voice: missingVoiceCount,
    speaker: missingSpeakerCount,
    directorProfile: missingDirectorCount,
    model: missingModelCount,
  };

  const directorProfileIds = new Set(lines.map((l) => l.directorProfileId).filter(Boolean) as string[]);
  const invalidDirectorRefs: string[] = [];
  for (const profileId of directorProfileIds) {
    if (!directorProfileExists(profileId)) {
      invalidDirectorRefs.push(profileId);
      issues.push({ severity: "error", code: "INVALID_DIRECTOR_REFERENCE", message: `Director profile "${profileId}" does not exist` });
    }
  }
  metrics.unboundDirectorCount = missingDirectorCount;
  metrics.missingPromptStructureCount = missingPromptStructureCount;
  metrics.incompletePromptProfileCount = incompletePromptProfileCount;
  metrics.invalidDirectorReferences = invalidDirectorRefs;

  const profileUsageCount: Record<string, number> = {};
  for (const line of lines) {
    if (line.directorProfileId) {
      profileUsageCount[line.directorProfileId] = (profileUsageCount[line.directorProfileId] ?? 0) + 1;
    }
  }
  const sharedProfiles = Object.entries(profileUsageCount).filter(([, count]) => count > 1);
  metrics.directorReuse = {
    uniqueProfiles: Object.keys(profileUsageCount).length,
    sharedProfiles: sharedProfiles.length,
    maxReuseCount: Math.max(0, ...Object.values(profileUsageCount)),
    reuseDetails: sharedProfiles.map(([id, count]) => ({ profileId: id, lineCount: count })),
  };

  const textMap = new Map<string, string[]>();
  for (const line of lines) {
    const normalized = line.text.trim().toLowerCase();
    if (!textMap.has(normalized)) textMap.set(normalized, []);
    textMap.get(normalized)!.push(line.lineId ?? line.id);
  }
  const duplicates = Array.from(textMap.entries()).filter(([, ids]) => ids.length > 1);
  metrics.suspectedDuplicates = {
    groups: duplicates.length,
    details: duplicates.map(([text, ids]) => ({ text: text.slice(0, 80), lineIds: ids })),
  };
  for (const [, ids] of duplicates) {
    issues.push({ severity: "warning", code: "DUPLICATE_TEXT", message: `Suspected duplicate text in lines: ${ids.join(", ")}`, lineId: ids[0] });
  }

  const longTextThreshold = 500;
  const longTextLines = lines.filter((l) => l.text.length > longTextThreshold);
  metrics.longText = {
    threshold: longTextThreshold,
    count: longTextLines.length,
    details: longTextLines.map((l) => ({ lineId: l.id, length: l.text.length })),
  };
  for (const line of longTextLines) {
    issues.push({ severity: "warning", code: "LONG_TEXT", message: `Line "${line.id}" text is ${line.text.length} chars (threshold: ${longTextThreshold})`, lineId: line.id });
  }

  const statusCounts: Record<string, number> = {};
  for (const line of lines) {
    const s = line.status ?? "pending";
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  const genStatusCounts: Record<string, number> = {};
  for (const line of lines) {
    const gs = line.generationStatus ?? "draft";
    genStatusCounts[gs] = (genStatusCounts[gs] ?? 0) + 1;
  }

  metrics.validationSummary = statusCounts;
  metrics.generationSummary = genStatusCounts;

  return { metrics, issues };
}
