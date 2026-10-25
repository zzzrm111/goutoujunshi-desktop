# API 服务

## 本地运行

```powershell
cd apps/api
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
# 新数据库执行 upgrade；已有旧数据库首次接入迁移前先备份，再执行 stamp head
python -m alembic upgrade head
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

`.env` 中配置 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME`（公开版默认全部留空，详见仓库根目录 `模型与语音接入指南.md`）。`MODEL_BASE_URL` 填 OpenAI-compatible API 的基础路径，例如 `https://provider.example/v1`，服务会请求其 `/chat/completions`。实时语音模式默认只带最近 6 条历史和最多 80 个输出 token，可通过 `MODEL_REALTIME_MAX_TOKENS`、`MODEL_REALTIME_HISTORY_MESSAGES` 调整；这两个值主要影响通话式回复的首字延迟。需要实时通话单独走低延迟型号时设置 `MODEL_REALTIME_NAME`，普通文字聊天仍使用 `MODEL_NAME`。`MODEL_REALTIME_FIRST_SEGMENT_CHARS` 控制模型开始说话前的首段最小字数，当前推荐值为 `8`，用于缩短首音频等待。

当前实时链路已按“说完即回”优化：前端约 `180ms` 起说、`450ms` 静音结束，VoiceStudio Sherpa 流式识别完成后立即触发回答；同一轮只接受一个 `utterance` final，EOF 的 `summary` 不会重复触发。实时 TTS 在整轮回答中复用一条 VoiceStudio WebSocket，不再对每个短句重新连接；VoiceStudio 侧建议用 `scripts/start-voicestudio.ps1` 启动，以获得 `1200` 采样点音频块和 `0.45s` 端点参数。

语音功能默认使用本地 Mock：

```dotenv
ASR_PROVIDER=mock
TTS_PROVIDER=mock
```

当前语音输入流程是“录音 -> 转写 -> 用户编辑 -> 手动发送”，不会自动发送识别结果。原始录音只在请求期间处理，不写入 SQLite；实际发送的文字仍走现有关系判断、专项 Skill 和 AI 女友核心 Skill 管线。

本机 VoiceStudio 同时提供 TTS 和 quicker-whisper ASR，可作为本地语音服务：

```dotenv
ASR_PROVIDER=voicestudio
ASR_BASE_URL=http://127.0.0.1:3900
ASR_MODEL=Systran/faster-whisper-base
ASR_REALTIME_MODEL=sherpa-zipformer-bilingual-zh-en

TTS_PROVIDER=voicestudio
TTS_BASE_URL=http://127.0.0.1:3900
TTS_MODEL=omnivoice
TTS_VOICE=
# VoiceStudio / OmniVoice 迭代步数：实时、聊天自动语音、手动播放分档
TTS_REALTIME_NUM_STEP=8
TTS_CHAT_NUM_STEP=8
TTS_MANUAL_NUM_STEP=12
```

`num_step` 越低合成越快、细节略减。实测本机 RTX 4060 Laptop 上单句 `8` 步约 `1.5–1.8s`、`12` 步约 `2.0–2.2s`；实时通话与聊天自动语音默认 `8`，手动播放默认 `12`，也可以在前端请求里单独覆盖。

VoiceStudio ASR 的普通上传接口使用 `POST /v1/audio/transcriptions`；实时通话优先使用 `WS /ws/transcribe?pcm=1&sr=16000&model=sherpa-zipformer-bilingual-zh-en`，走 Sherpa 的中英流式识别，避免等整段录音结束后再转写。接入其他 OpenAI-compatible 服务时，可将 `ASR_PROVIDER` 或 `TTS_PROVIDER` 改为 `cloud`，并填写对应的 `ASR_BASE_URL`、`ASR_API_KEY`、`ASR_MODEL` 或 `TTS_BASE_URL`、`TTS_API_KEY`、`TTS_MODEL`。API Key 只保存在后端 `.env`，不要放入前端。

语音接口：

- `POST /api/v1/speech/transcribe`：上传音频并返回可编辑转写文本。
- `POST /api/v1/speech/synthesize`：将已完成的 AI 文字回复合成为音频。普通聊天的自动语音默认开启，可在顶部“自动语音/语音关闭”切换。Mock 返回测试音频并标记浏览器朗读兜底，VoiceStudio 或 `cloud` 返回真实音频。
- `WS /api/v1/realtime/{session_id}`：实时语音通话。浏览器持续发送 PCM16 音频帧；服务端每轮建立独立 ASR 流，收到 `turn.end` 后立即结束识别，模型 token 到达后按段发起流式 TTS，并把 PCM16 音频帧持续回传。旧版 `audio.chunk` / `audio.commit` 协议仍兼容。

当前已实现 WebSocket 实时语音、Sherpa 流式 ASR、首段流式 TTS、浏览器 VAD 自动断句和普通聊天自动语音。最影响体感的剩余延迟是模型服务的首 token 延迟；首 token 延迟取决于所接入的模型服务，建议在 `MODEL_REALTIME_NAME` 里单独指定低延迟型号。VoiceStudio 的 TTS 首音频在热模型下约 `1.2–1.5s`，不是主要瓶颈。尚未实现 WebRTC、人物模型和持续后台采集。

默认使用 `apps/api/data/assistant.db` SQLite 文件，便于本地试跑。正式启动前使用 Alembic 管理数据库结构；已有旧数据库首次接入迁移时先执行 `python -m alembic stamp head`，新数据库执行 `python -m alembic upgrade head`。设置 `DATABASE_URL` 可切换到 PostgreSQL；切换 PostgreSQL 时需安装 `psycopg[binary]`，并配置如 `postgresql+psycopg://user:password@localhost:5432/assistant`。

## 测试

```powershell
python -m pytest
```

接口文档：启动后访问 `http://127.0.0.1:8001/docs`。
