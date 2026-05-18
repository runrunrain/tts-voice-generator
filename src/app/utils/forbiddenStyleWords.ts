export interface ForbiddenStyleUiMatch {
  field: string;
  term: string;
  suggestion: string;
}

interface ForbiddenStyleTerm {
  term: string;
  language: "en" | "zh";
  suggestion: string;
  pattern?: RegExp;
}

const FORBIDDEN_STYLE_TERMS: ForbiddenStyleTerm[] = [
  { term: "quiet", language: "en", suggestion: "warm, intimate, close-mic, emotionally restrained" },
  { term: "flat", language: "en", suggestion: "steady but expressive, controlled tension" },
  {
    term: "no rush",
    language: "en",
    suggestion: "measured pace, pause before key nouns",
    pattern: /(^|[^A-Za-z])no[\s-]+rush(?![A-Za-z])/i,
  },
  { term: "careful", language: "en", suggestion: "precise articulation, grounded confidence" },
  { term: "whispered", language: "en", suggestion: "soft-spoken, close, confidential" },
  { term: "安静", language: "zh", suggestion: "贴近、温暖、克制" },
  { term: "平稳", language: "zh", suggestion: "稳定但有情绪弧线" },
  { term: "平淡", language: "zh", suggestion: "克制但有重点" },
  { term: "不急", language: "zh", suggestion: "关键句前停顿 300-500ms" },
  { term: "小心", language: "zh", suggestion: "清晰咬字、可信、温和" },
].map((entry) => ({
  ...entry,
  pattern: entry.pattern ?? (entry.language === "en" ? buildEnglishTermPattern(entry.term) : undefined),
}));

export function findForbiddenStyleWords(
  fields: Array<{ field: string; value?: string | null }>,
): ForbiddenStyleUiMatch[] {
  const matches: ForbiddenStyleUiMatch[] = [];

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
      matches.push({ field, term: entry.term, suggestion: entry.suggestion });
    }
  }

  return matches;
}

export function formatForbiddenStyleWarning(matches: ForbiddenStyleUiMatch[]): string {
  const terms = Array.from(new Set(matches.map((match) => match.term)));
  const suggestions = Array.from(
    new Map(matches.map((match) => [match.term, `${match.term} -> ${match.suggestion}`])).values(),
  );
  return `检测到可能导致 Gemini TTS 输出平淡或机械的风格词：${terms.join(", ")}。建议改为更具体的情绪、距离感或停顿指令：${suggestions.join("；")}。`;
}

export function getForbiddenMatchesForField(matches: ForbiddenStyleUiMatch[], field: string): ForbiddenStyleUiMatch[] {
  return matches.filter((match) => match.field === field);
}

function buildEnglishTermPattern(term: string): RegExp {
  return new RegExp(`(^|[^A-Za-z])${escapeRegExp(term)}(?![A-Za-z])`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
