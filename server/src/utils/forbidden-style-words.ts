export type ForbiddenStyleField =
  | "audioProfile"
  | "style"
  | "pacing"
  | "performanceNotes"
  | "directorNotes"
  | "lineStyle"
  | `speakers[${number}].style`;

export interface ForbiddenStyleMatch {
  field: ForbiddenStyleField;
  term: string;
}

export interface ForbiddenStyleWarningDetails {
  severity: "warning";
  matches: Array<{ field: string; term: string }>;
}

interface ForbiddenStyleTerm {
  term: string;
  language: "en" | "zh";
  suggestion: string;
  pattern?: RegExp;
}

export const FORBIDDEN_STYLE_WARNING_FIELD =
  "audioProfile,style,pacing,performanceNotes,directorNotes,lineStyle,speakers[].style";

export const FORBIDDEN_STYLE_WARNING_SUGGESTION =
  "建议改为更具体的情绪、距离感或停顿指令。";

const RAW_FORBIDDEN_STYLE_TERMS: ForbiddenStyleTerm[] = [
  { term: "quiet", language: "en", suggestion: "warm, intimate, close-mic, emotionally restrained" },
  { term: "flat", language: "en", suggestion: "steady but expressive, controlled tension" },
  {
    term: "no rush",
    language: "en",
    suggestion: "measured pace, pause before key nouns",
    pattern: /(?<![A-Za-z])no[\s-]+rush(?![A-Za-z])/i,
  },
  { term: "careful", language: "en", suggestion: "precise articulation, grounded confidence" },
  { term: "whispered", language: "en", suggestion: "soft-spoken, close, confidential" },
  { term: "安静", language: "zh", suggestion: "贴近、温暖、克制" },
  { term: "平稳", language: "zh", suggestion: "稳定但有情绪弧线" },
  { term: "平淡", language: "zh", suggestion: "克制但有重点" },
  { term: "不急", language: "zh", suggestion: "关键句前停顿 300-500ms" },
  { term: "小心", language: "zh", suggestion: "清晰咬字、可信、温和" },
];

const FORBIDDEN_STYLE_TERMS: ForbiddenStyleTerm[] = RAW_FORBIDDEN_STYLE_TERMS.map((entry) => ({
  ...entry,
  pattern: entry.pattern ?? (entry.language === "en" ? buildEnglishTermPattern(entry.term) : undefined),
}));

export function findForbiddenStyleWordMatches(
  fields: Array<{ field: ForbiddenStyleField; value: string | undefined | null }>,
): ForbiddenStyleMatch[] {
  const matches: ForbiddenStyleMatch[] = [];

  for (const { field, value } of fields) {
    if (value === undefined || value === null) continue;
    const normalized = String(value).normalize("NFKC");
    if (!normalized.trim()) continue;

    const fieldTerms = new Set<string>();
    for (const entry of FORBIDDEN_STYLE_TERMS) {
      const matched = entry.language === "zh"
        ? normalized.includes(entry.term)
        : Boolean(entry.pattern?.test(normalized));
      if (!matched || fieldTerms.has(entry.term)) continue;
      fieldTerms.add(entry.term);
      matches.push({ field, term: entry.term });
    }
  }

  return matches;
}

export function formatForbiddenStyleWarningMessage(matches: ForbiddenStyleMatch[]): string {
  const terms = Array.from(new Set(matches.map((match) => match.term)));
  return `检测到可能导致 Gemini TTS 输出平淡或机械的风格词：${terms.join(", ")}。${FORBIDDEN_STYLE_WARNING_SUGGESTION}`;
}

export function buildForbiddenStyleWarningDetails(matches: ForbiddenStyleMatch[]): ForbiddenStyleWarningDetails {
  return {
    severity: "warning",
    matches: matches.slice(0, 20).map((match) => ({ field: match.field, term: match.term })),
  };
}

export function getForbiddenStyleSuggestion(term: string): string | undefined {
  return FORBIDDEN_STYLE_TERMS.find((entry) => entry.term === term)?.suggestion;
}

function buildEnglishTermPattern(term: string): RegExp {
  return new RegExp(`(?<![A-Za-z])${escapeRegExp(term)}(?![A-Za-z])`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
