import type { VoiceProfile } from "../types";

type VoiceDisplayMeta = {
  displayName: string;
  toneDescription: string;
};

export const GEMINI_VOICE_DISPLAY: Record<string, VoiceDisplayMeta> = {
  Zephyr: { displayName: "和风", toneDescription: "明亮、自然" },
  Puck: { displayName: "顽童", toneDescription: "欢快、机敏" },
  Charon: { displayName: "卡戎", toneDescription: "低沉、信息量强" },
  Kore: { displayName: "珂瑞", toneDescription: "坚定、果断" },
  Fenrir: { displayName: "芬里尔", toneDescription: "兴奋、有冲击力" },
  Leda: { displayName: "勒达", toneDescription: "青春、轻盈" },
  Orus: { displayName: "奥鲁斯", toneDescription: "稳重、正式" },
  Aoede: { displayName: "艾俄德", toneDescription: "轻松、流畅" },
  Callirrhoe: { displayName: "卡利罗厄", toneDescription: "放松、舒缓" },
  Autonoe: { displayName: "奥托诺厄", toneDescription: "明快、清亮" },
  Enceladus: { displayName: "恩克拉多斯", toneDescription: "气声、虚弱感" },
  Iapetus: { displayName: "伊阿珀托斯", toneDescription: "清晰、理性" },
  Umbriel: { displayName: "翁布里尔", toneDescription: "轻松愉快" },
  Algieba: { displayName: "阿尔吉巴", toneDescription: "平滑、圆润" },
  Despina: { displayName: "德斯皮娜", toneDescription: "平滑、亲和" },
  Erinome: { displayName: "厄里诺墨", toneDescription: "清澈、干净" },
  Algenib: { displayName: "阿尔杰尼布", toneDescription: "沙哑、粗粝" },
  Rasalgethi: { displayName: "拉萨尔格提", toneDescription: "信息丰富、厚实" },
  Laomedeia: { displayName: "拉俄墨得亚", toneDescription: "欢快、热情" },
  Achernar: { displayName: "水委一", toneDescription: "柔和、安抚" },
  Alnilam: { displayName: "参宿二", toneDescription: "坚定、有力" },
  Schedar: { displayName: "王良四", toneDescription: "平稳、克制" },
  Gacrux: { displayName: "十字架一", toneDescription: "成熟、稳健" },
  Pulcherrima: { displayName: "普尔凯里玛", toneDescription: "前瞻、明亮" },
  Achird: { displayName: "阿基尔德", toneDescription: "友好、亲切" },
  Zubenelgenubi: { displayName: "氐宿一", toneDescription: "随意、口语" },
  Vindemiatrix: { displayName: "太微左垣四", toneDescription: "温和、细腻" },
  Sadachbia: { displayName: "萨达克比亚", toneDescription: "活泼、灵动" },
  Sadaltager: { displayName: "萨达尔塔格", toneDescription: "博学、沉着" },
  Sulafat: { displayName: "苏拉法特", toneDescription: "偏高、明亮" },
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
  return `${meta.displayName}（${voiceName}${tone ? ` · ${tone}` : ""}）`;
}

export function formatVoiceCompactLabel(voiceName: string): string {
  const meta = getVoiceDisplayMeta(voiceName);
  return meta.displayName === voiceName ? voiceName : `${meta.displayName}（${voiceName}）`;
}

export function voiceMatchesQuery(voice: VoiceProfile, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const meta = getVoiceDisplayMeta(voice.name);
  return [voice.name, voice.displayName, meta.displayName, meta.toneDescription, voice.toneDescription, voice.role]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(normalized));
}
