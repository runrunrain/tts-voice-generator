/**
 * Voice canonicalization utilities.
 *
 * Policy:
 * - `Zephyr` is the canonical default voice (Gemini TTS).
 * - `alloy` is a legacy alias that maps to `Zephyr`.
 * - All new configuration output must use canonical names.
 * - Legacy alias is accepted as input for backward compatibility.
 */

export interface GeminiVoiceCatalogEntry {
  name: string;
  displayNameZh: string;
  toneZh: string;
  selectionHints: string[];
}

export const GEMINI_VOICE_CATALOG: readonly GeminiVoiceCatalogEntry[] = [
  { name: "Zephyr", displayNameZh: "和风", toneZh: "明亮、自然", selectionHints: ["明亮旁白", "中性叙述", "默认自然声"] },
  { name: "Puck", displayNameZh: "顽童", toneZh: "欢快、机敏", selectionHints: ["少年", "年轻角色", "俏皮调侃", "轻快台词"] },
  { name: "Charon", displayNameZh: "卡戎", toneZh: "低沉、信息量强", selectionHints: ["长者", "权威", "讲解", "低沉稳重", "训诫"] },
  { name: "Kore", displayNameZh: "珂瑞", toneZh: "坚定、果断", selectionHints: ["坚定女性", "女将", "果断宣告", "强势角色"] },
  { name: "Fenrir", displayNameZh: "芬里尔", toneZh: "兴奋、有冲击力", selectionHints: ["战斗", "冲锋", "激动", "愤怒", "高能喊话"] },
  { name: "Leda", displayNameZh: "勒达", toneZh: "青春、轻盈", selectionHints: ["少女", "年轻女性", "清新", "活泼温和"] },
  { name: "Orus", displayNameZh: "奥鲁斯", toneZh: "稳重、正式", selectionHints: ["军政汇报", "正式陈述", "沉着指令", "稳重男性"] },
  { name: "Aoede", displayNameZh: "艾俄德", toneZh: "轻松、流畅", selectionHints: ["轻松说明", "朋友交流", "日常对白"] },
  { name: "Callirrhoe", displayNameZh: "卡利罗厄", toneZh: "放松、舒缓", selectionHints: ["放松叙述", "舒缓说明", "慢节奏"] },
  { name: "Autonoe", displayNameZh: "奥托诺厄", toneZh: "明快、清亮", selectionHints: ["明快播报", "积极提示", "清晰短句"] },
  { name: "Enceladus", displayNameZh: "恩克拉多斯", toneZh: "气声、虚弱感", selectionHints: ["耳语", "疲惫", "神秘", "低声"] },
  { name: "Iapetus", displayNameZh: "伊阿珀托斯", toneZh: "清晰、理性", selectionHints: ["清晰解释", "理性说明", "教程"] },
  { name: "Umbriel", displayNameZh: "翁布里尔", toneZh: "轻松愉快", selectionHints: ["轻松愉快", "随和", "明亮互动"] },
  { name: "Algieba", displayNameZh: "阿尔吉巴", toneZh: "平滑、圆润", selectionHints: ["圆润播报", "平顺叙述", "广告旁白"] },
  { name: "Despina", displayNameZh: "德斯皮娜", toneZh: "平滑、亲和", selectionHints: ["亲和说明", "客服", "平稳对话"] },
  { name: "Erinome", displayNameZh: "厄里诺墨", toneZh: "清澈、干净", selectionHints: ["清澈女声", "纯净叙述", "清亮说明"] },
  { name: "Algenib", displayNameZh: "阿尔杰尼布", toneZh: "沙哑、粗粝", selectionHints: ["粗粝角色", "沙哑", "疲惫老兵", "市井感"] },
  { name: "Rasalgethi", displayNameZh: "拉萨尔格提", toneZh: "信息丰富、厚实", selectionHints: ["史诗旁白", "资料解说", "厚重叙述"] },
  { name: "Laomedeia", displayNameZh: "拉俄墨得亚", toneZh: "欢快、热情", selectionHints: ["欢快女性", "热情介绍", "轻喜剧"] },
  { name: "Achernar", displayNameZh: "水委一", toneZh: "柔和、安抚", selectionHints: ["温柔", "安抚", "治愈", "柔和旁白"] },
  { name: "Alnilam", displayNameZh: "参宿二", toneZh: "坚定、有力", selectionHints: ["坚定宣告", "命令", "不容置疑", "强执行"] },
  { name: "Schedar", displayNameZh: "王良四", toneZh: "平稳、克制", selectionHints: ["克制叙述", "平稳旁白", "中性成熟"] },
  { name: "Gacrux", displayNameZh: "十字架一", toneZh: "成熟、稳健", selectionHints: ["成熟角色", "稳健旁白", "中年叙述"] },
  { name: "Pulcherrima", displayNameZh: "普尔凯里玛", toneZh: "前瞻、明亮", selectionHints: ["科技感", "未来感", "宣传介绍"] },
  { name: "Achird", displayNameZh: "阿基尔德", toneZh: "友好、亲切", selectionHints: ["友好对话", "亲切提示", "陪伴感"] },
  { name: "Zubenelgenubi", displayNameZh: "氐宿一", toneZh: "随意、口语", selectionHints: ["随意闲聊", "市井对白", "自然口语"] },
  { name: "Vindemiatrix", displayNameZh: "太微左垣四", toneZh: "温和、细腻", selectionHints: ["温和解释", "细腻情绪", "安静对白"] },
  { name: "Sadachbia", displayNameZh: "萨达克比亚", toneZh: "活泼、灵动", selectionHints: ["活泼", "灵动", "轻快互动", "年轻角色"] },
  { name: "Sadaltager", displayNameZh: "萨达尔塔格", toneZh: "博学、沉着", selectionHints: ["学者", "知识讲解", "冷静分析", "智者"] },
  { name: "Sulafat", displayNameZh: "苏拉法特", toneZh: "偏高、明亮", selectionHints: ["高音色", "清亮提醒", "活泼短句"] },
];

/** Map of legacy alias -> canonical voice name */
const VOICE_ALIAS_MAP: ReadonlyMap<string, string> = new Map([
  ["alloy", "Zephyr"],
]);

const VOICE_CANONICAL_NAME_MAP: ReadonlyMap<string, string> = new Map([
  ...GEMINI_VOICE_CATALOG.map((voice) => [voice.name.toLowerCase(), voice.name] as const),
  ...Array.from(VOICE_ALIAS_MAP.entries()),
]);

const VOICE_MATCH_ALIASES: ReadonlyMap<string, string> = new Map(
  GEMINI_VOICE_CATALOG.flatMap((voice) => [
    [voice.name.toLowerCase(), voice.name] as const,
    [voice.displayNameZh.toLowerCase(), voice.name] as const,
  ]),
);

/**
 * Canonicalize a voice name.
 *
 * - If the voice is a known legacy alias, returns the canonical name.
 * - Otherwise returns the voice unchanged (pass-through for valid Gemini voices).
 * - Case-insensitive for alias matching.
 */
export function canonicalizeVoice(voice: string): string {
  const trimmed = voice?.trim();
  if (!trimmed) return "Zephyr";
  const mapped = VOICE_CANONICAL_NAME_MAP.get(trimmed.toLowerCase());
  return mapped ?? trimmed;
}

/**
 * Check if a voice name is a known legacy alias.
 */
export function isLegacyAlias(voice: string): boolean {
  return VOICE_ALIAS_MAP.has(voice.toLowerCase());
}

export function getVoiceDisplayNameZh(voice: string): string {
  const canonical = canonicalizeVoice(voice);
  return GEMINI_VOICE_CATALOG.find((entry) => entry.name === canonical)?.displayNameZh ?? canonical;
}

export function formatVoiceSelectionGuideForPrompt(): string {
  return GEMINI_VOICE_CATALOG
    .map((voice) => `${voice.name}（${voice.displayNameZh}）：${voice.toneZh}；适合 ${voice.selectionHints.join("、")}`)
    .join("\n");
}

export function inferVoiceForTextContext(...parts: Array<string | null | undefined>): string {
  const source = parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ");
  const normalized = source.toLowerCase();
  for (const [alias, voice] of VOICE_MATCH_ALIASES.entries()) {
    if (normalized.includes(alias)) return voice;
  }
  if (/(老|长者|族老|长老|权威|训诫|低沉|威严|深沉|儒|先生|elder|senior|old|deep|authoritative)/i.test(source)) return "Charon";
  if (/(学者|谋士|智者|博学|分析|讲解|知识|典籍|teacher|scholar|wise|knowledge)/i.test(source)) return "Sadaltager";
  if (/(女将|女性|女子|姑娘|少女|girl|female|woman)/i.test(source)) {
    if (/(坚定|果断|强势|命令|firm|decisive)/i.test(source)) return "Kore";
    if (/(温柔|柔和|安抚|清澈|soft|gentle|clear)/i.test(source)) return "Erinome";
    return "Leda";
  }
  if (/(将军|统帅|军令|命令|宣告|坚定|不可动摇|果断|commander|command|firm|decisive)/i.test(source)) return "Alnilam";
  if (/(冲锋|战斗|激动|怒|愤|咆哮|高昂|热血|紧急|battle|angry|excited|urgent)/i.test(source)) return "Fenrir";
  if (/(少年|青年|年轻|机灵|俏皮|轻快|活泼|young|teen|playful|lively|fast|sharp)/i.test(source)) return "Puck";
  if (/(温柔|柔和|安抚|治愈|舒缓|温和|gentle|soft|calm|soothing)/i.test(source)) return "Achernar";
  if (/(市井|随意|闲聊|口语|朋友|casual|chat|street|friendly)/i.test(source)) return "Zubenelgenubi";
  if (/(沙哑|粗粝|疲惫|老兵|沧桑|hoarse|gravelly|tired)/i.test(source)) return "Algenib";
  if (/(旁白|叙述|史诗|历史|开场|narrator|narration|epic|history)/i.test(source)) return "Rasalgethi";
  if (/(教程|说明|清晰|理性|步骤|guide|tutorial|clear|explain)/i.test(source)) return "Iapetus";
  return "Zephyr";
}

/**
 * Get the canonical default voice name.
 */
export function getDefaultVoice(): string {
  return "Zephyr";
}
