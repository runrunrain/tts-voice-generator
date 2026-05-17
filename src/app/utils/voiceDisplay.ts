import type { VoiceProfile } from "../types";

type VoiceDisplayMeta = {
  displayName: string;
  toneDescription: string;
  /**
   * Speaker gender from the Google/Provider Gemini TTS voice table.
   * This mirrors the server catalog mapping; Gemini prebuilt voices are male or female only.
   */
  perceivedGender?: VoicePerceivedGender;
};

export type VoicePerceivedGender = "male" | "female";

const PERCEIVED_GENDER_LABEL_ZH: Record<VoicePerceivedGender, string> = {
  male: "男声",
  female: "女声",
};

export const GEMINI_VOICE_DISPLAY: Record<string, VoiceDisplayMeta> = {
  Zephyr: { displayName: "和风", toneDescription: "明亮、自然", perceivedGender: "female" },
  Puck: { displayName: "顽童", toneDescription: "欢快、机敏", perceivedGender: "male" },
  Charon: { displayName: "卡戎", toneDescription: "低沉、信息量强", perceivedGender: "male" },
  Kore: { displayName: "珂瑞", toneDescription: "坚定、果断", perceivedGender: "female" },
  Fenrir: { displayName: "芬里尔", toneDescription: "兴奋、有冲击力", perceivedGender: "male" },
  Leda: { displayName: "勒达", toneDescription: "青春、轻盈", perceivedGender: "female" },
  Orus: { displayName: "奥鲁斯", toneDescription: "稳重、正式", perceivedGender: "male" },
  Aoede: { displayName: "艾俄德", toneDescription: "轻松、流畅", perceivedGender: "female" },
  Callirrhoe: { displayName: "卡利罗厄", toneDescription: "放松、舒缓", perceivedGender: "female" },
  Autonoe: { displayName: "奥托诺厄", toneDescription: "明快、清亮", perceivedGender: "female" },
  Enceladus: { displayName: "恩克拉多斯", toneDescription: "气声、虚弱感", perceivedGender: "male" },
  Iapetus: { displayName: "伊阿珀托斯", toneDescription: "清晰、理性", perceivedGender: "male" },
  Umbriel: { displayName: "翁布里尔", toneDescription: "轻松愉快", perceivedGender: "male" },
  Algieba: { displayName: "阿尔吉巴", toneDescription: "平滑、圆润", perceivedGender: "male" },
  Despina: { displayName: "德斯皮娜", toneDescription: "平滑、亲和", perceivedGender: "female" },
  Erinome: { displayName: "厄里诺墨", toneDescription: "清澈、干净", perceivedGender: "female" },
  Algenib: { displayName: "阿尔杰尼布", toneDescription: "沙哑、粗粝", perceivedGender: "male" },
  Rasalgethi: { displayName: "拉萨尔格提", toneDescription: "信息丰富、厚实", perceivedGender: "male" },
  Laomedeia: { displayName: "拉俄墨得亚", toneDescription: "欢快、热情", perceivedGender: "female" },
  Achernar: { displayName: "水委一", toneDescription: "柔和、安抚", perceivedGender: "female" },
  Alnilam: { displayName: "参宿二", toneDescription: "坚定、有力", perceivedGender: "male" },
  Schedar: { displayName: "王良四", toneDescription: "平稳、克制", perceivedGender: "male" },
  Gacrux: { displayName: "十字架一", toneDescription: "成熟、稳健", perceivedGender: "female" },
  Pulcherrima: { displayName: "普尔凯里玛", toneDescription: "前瞻、明亮", perceivedGender: "female" },
  Achird: { displayName: "阿基尔德", toneDescription: "友好、亲切", perceivedGender: "male" },
  Zubenelgenubi: { displayName: "氐宿一", toneDescription: "随意、口语", perceivedGender: "male" },
  Vindemiatrix: { displayName: "太微左垣四", toneDescription: "温和、细腻", perceivedGender: "female" },
  Sadachbia: { displayName: "萨达克比亚", toneDescription: "活泼、灵动", perceivedGender: "male" },
  Sadaltager: { displayName: "萨达尔塔格", toneDescription: "博学、沉着", perceivedGender: "male" },
  Sulafat: { displayName: "苏拉法特", toneDescription: "偏高、明亮", perceivedGender: "female" },
};

export function getVoiceDisplayMeta(voiceName: string): VoiceDisplayMeta {
  return GEMINI_VOICE_DISPLAY[voiceName] ?? { displayName: voiceName, toneDescription: "自定义音色" };
}

export function getVoiceDisplayName(voiceName: string): string {
  return getVoiceDisplayMeta(voiceName).displayName;
}

export function formatVoiceOptionLabel(voiceName: string, role?: string | null): string {
  const meta = getVoiceDisplayMeta(voiceName);
  const tone = role?.trim() || meta.toneDescription;
  const nameLabel = meta.displayName === voiceName ? voiceName : `${voiceName}（${meta.displayName}）`;
  const genderLabel = meta.perceivedGender ? PERCEIVED_GENDER_LABEL_ZH[meta.perceivedGender] : null;
  return [nameLabel, genderLabel, tone].filter(Boolean).join(" · ");
}

export function formatVoiceCompactLabel(voiceName: string): string {
  const meta = getVoiceDisplayMeta(voiceName);
  return meta.displayName === voiceName ? voiceName : `${meta.displayName}（${voiceName}）`;
}

export function voiceMatchesQuery(voice: VoiceProfile, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const meta = getVoiceDisplayMeta(voice.name);
  const genderLabel = meta.perceivedGender ? PERCEIVED_GENDER_LABEL_ZH[meta.perceivedGender] : null;
  return [voice.name, voice.displayName, meta.displayName, genderLabel, meta.toneDescription, voice.toneDescription, voice.role]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(normalized));
}
