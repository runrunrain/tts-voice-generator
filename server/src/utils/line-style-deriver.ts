const TAG_PATTERN = /\[(whisper|shout|laugh|sigh|pause|happy|sad|angry|excited|calm|soft|loud)\]/gi;
const ANY_TAG_PATTERN = /\[[^\]\r\n]{1,32}\]/g;

const TAG_STYLE_PHRASES: Record<string, string> = {
  whisper: "轻声贴近",
  shout: "声量更强",
  laugh: "带笑意",
  sigh: "带叹息感",
  pause: "留出停顿",
  happy: "情绪明亮",
  sad: "情绪低缓",
  angry: "情绪更有力度",
  excited: "情绪更饱满",
  calm: "语气沉稳",
  soft: "语气柔和",
  loud: "声量更强",
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readableText(value: string): string {
  return normalizeWhitespace(value.replace(ANY_TAG_PATTERN, " "));
}

function readableLength(value: string): number {
  return Array.from(value.replace(/[\s\p{P}\p{S}]/gu, "")).length;
}

function firstTagPhrase(value: string): string | null {
  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(value)) !== null) {
    const phrase = TAG_STYLE_PHRASES[match[1].toLowerCase()];
    if (phrase) return phrase;
  }
  return null;
}

function hasDialogueMarker(value: string): boolean {
  if (/[“”"'‘’]/.test(value)) return true;
  return /(?:^|[\s，。！？；;,.!?])(?:旁白|对白|独白|内心|[\p{Script=Han}A-Za-z0-9_]{1,12}(?:说|问|道|喊|答|回应|回复|表示))\s*[:：]\s*\S/u.test(value);
}

function addPhrase(phrases: string[], phrase: string): void {
  if (phrases.length >= 3) return;
  if (!phrases.includes(phrase)) phrases.push(phrase);
}

function addPhrases(phrases: string[], ...values: string[]): void {
  for (const value of values) addPhrase(phrases, value);
}

function finalizePhrases(phrases: string[]): string {
  const output = phrases.slice(0, 3).join("，");
  return output.length <= 64 ? output : output.slice(0, 64);
}

/**
 * Derive a transient line-level performance style from transcript text.
 *
 * This is a pure, synchronous rule helper. It does not persist the result and
 * does not call external services. Empty input, tag-only input, and text with
 * fewer than two readable characters intentionally return an empty string so
 * the existing prompt fallback behavior remains available.
 */
export function deriveLineStyleFromTranscript(transcript: string): string {
  const normalized = normalizeWhitespace(transcript);
  if (!normalized) return "";

  const text = readableText(normalized);
  const textLength = readableLength(text);
  if (!text || textLength < 2) return "";

  const phrases: string[] = [];
  const tagPhrase = firstTagPhrase(normalized);
  if (tagPhrase) addPhrase(phrases, tagPhrase);

  if (/[?？]/.test(text) || /[吗呢么]$/.test(text) || /(为什么|怎么|如何|什么|哪里|是否)/.test(text)) {
    addPhrases(phrases, "提问语气", "尾音自然上扬");
  }

  if (phrases.length < 3 && (/[!！]/.test(text) || /(太|真|终于|糟糕|天哪|哇|啊呀|厉害)/.test(text))) {
    addPhrases(phrases, "感叹表达", "情绪更饱满");
  }

  if (phrases.length < 3 && /(……|\.\.\.|嗯|呃|唉|欸)/.test(text)) {
    addPhrases(phrases, "带停顿", "思考感");
  }

  if (phrases.length < 3 && /(请|先|然后|接着|点击|确认|输入|选择|步骤|完成)/.test(text)) {
    addPhrases(phrases, "事务引导", "表达清晰");
  }

  if (phrases.length < 3 && hasDialogueMarker(text)) {
    addPhrase(phrases, "对话感自然");
  }

  if (phrases.length < 3) {
    if (textLength >= 120) {
      addPhrases(phrases, "长段叙述", "分句停顿清晰", "保持连贯");
    } else if (textLength <= 18) {
      addPhrases(phrases, "短句表达", "干净利落");
    }
  }

  if (phrases.length === 0) {
    addPhrases(phrases, "自然叙述", "语气清晰可信", "节奏平稳");
  } else if (phrases.length < 3) {
    addPhrase(phrases, "节奏平稳");
  }

  return finalizePhrases(phrases);
}
