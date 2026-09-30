import { ensureDirs, getSettings } from './config.js';
import { getDb } from './db.js';
import { createApp } from './server.js';

ensureDirs();
getDb();

const settings = getSettings();
const port = Number(settings.OPENAI_BASE_URL ? process.env.PORT || 3132 : 3132);

const app = createApp();
app.listen(port, () => {
  console.log(`AutoTimingSFX API  → http://localhost:${port}`);
  console.log(`  base LLM : ${settings.OPENAI_BASE_URL}`);
  console.log(`  model    : ${settings.MODEL_NAME}`);
  console.log(`  VLM      : ${settings.VLM_MODEL}`);
  console.log(`  audio.cpp: ${settings.AUDIOCPP_SERVER}`);
  console.log(`  whisper  : ${settings.WHISPER_ONNX_MODEL} (${settings.WHISPER_ONNX_DTYPE})`);
});
