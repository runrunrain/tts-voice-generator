/**
 * Seed data: 30 official Gemini TTS voices.
 *
 * Voice names and style descriptions from:
 * https://ai.google.dev/gemini-api/docs/speech-generation
 *
 * One voice (Zephyr) is seeded as source=default, all others as source=candidate.
 */

import { getDb } from "./index.js";
import { voiceProfile, settings } from "./schema.js";
import { eq } from "drizzle-orm";

interface VoiceSeed {
  name: string;
  role: string;
  source: "default" | "candidate";
}

const GEMINI_VOICES: VoiceSeed[] = [
  { name: "Zephyr", role: "明亮", source: "default" },
  { name: "Puck", role: "欢快", source: "candidate" },
  { name: "Charon", role: "信息丰富", source: "candidate" },
  { name: "Kore", role: "坚定", source: "candidate" },
  { name: "Fenrir", role: "兴奋", source: "candidate" },
  { name: "Leda", role: "青春", source: "candidate" },
  { name: "Orus", role: "稳重", source: "candidate" },
  { name: "Aoede", role: "轻松", source: "candidate" },
  { name: "Callirrhoe", role: "放松", source: "candidate" },
  { name: "Autonoe", role: "明亮", source: "candidate" },
  { name: "Enceladus", role: "气声", source: "candidate" },
  { name: "Iapetus", role: "清晰", source: "candidate" },
  { name: "Umbriel", role: "轻松愉快", source: "candidate" },
  { name: "Algieba", role: "平滑", source: "candidate" },
  { name: "Despina", role: "平滑", source: "candidate" },
  { name: "Erinome", role: "清澈", source: "candidate" },
  { name: "Algenib", role: "沙哑", source: "candidate" },
  { name: "Rasalgethi", role: "信息丰富", source: "candidate" },
  { name: "Laomedeia", role: "欢快", source: "candidate" },
  { name: "Achernar", role: "柔和", source: "candidate" },
  { name: "Alnilam", role: "坚定", source: "candidate" },
  { name: "Schedar", role: "平稳", source: "candidate" },
  { name: "Gacrux", role: "成熟", source: "candidate" },
  { name: "Pulcherrima", role: "前瞻", source: "candidate" },
  { name: "Achird", role: "友好", source: "candidate" },
  { name: "Zubenelgenubi", role: "随意", source: "candidate" },
  { name: "Vindemiatrix", role: "温和", source: "candidate" },
  { name: "Sadachbia", role: "活泼", source: "candidate" },
  { name: "Sadaltager", role: "博学", source: "candidate" },
  { name: "Sulafat", role: "偏高", source: "candidate" },
];

/**
 * Seed voice profiles if table is empty.
 * Also seed default settings row if missing.
 */
export function seedDatabase() {
  const db = getDb();

  // Seed default settings if not exists
  const existingSettings = db.select().from(settings).where(eq(settings.id, 1)).get();
  if (!existingSettings) {
    db.insert(settings).values({
      id: 1,
      updatedAt: new Date(),
    }).run();
    console.log("[seed] Default settings row created");
  }

  // Seed voices only if table is empty
  const existingVoices = db.select().from(voiceProfile).all();
  if (existingVoices.length === 0) {
    const now = new Date();
    for (const voice of GEMINI_VOICES) {
      db.insert(voiceProfile).values({
        name: voice.name,
        role: voice.role,
        source: voice.source,
        provider: "openrouter",
        model: "google/gemini-3.1-flash-tts-preview",
        verifiedStatus: "unknown",
        createdAt: now,
        updatedAt: now,
      }).run();
    }
    console.log(`[seed] ${GEMINI_VOICES.length} Gemini voice profiles seeded`);
  } else {
    console.log(`[seed] Voice profiles already exist (${existingVoices.length}), skipping`);
  }
}
