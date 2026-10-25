# 实时语音低延迟方案

## 目标

把原本“录完整段、再转写、再等完整回答、再合成语音”的回合制流程，收敛成接近即时通话的连续体验：

- 用户开口时保持采集。
- 用户停止说话约 450ms 后立即提交本轮到识别。
- 识别 final 一到达就启动回答生成。
- 模型生成首个短句后立即开始语音合成。
- 用户再次开口时可以直接打断当前回答。

## 当前链路

```text
浏览器麦克风
  -> 前端 VAD（180ms 起说 / 450ms 静音）
  -> PCM16 16kHz WebSocket
  -> VoiceStudio /ws/transcribe（Sherpa Zipformer 流式识别）
  -> 应用后端 /api/v1/realtime/{session_id}
  -> LLM streaming chat completions
  -> 首段文本阈值 6 字
  -> VoiceStudio /ws/tts 长连接流式 PCM16
  -> 浏览器 AudioContext 连续播放
```

## 关键优化

### 1. 真正的流式 ASR

`.env` 设置：

```dotenv
ASR_REALTIME_MODEL=sherpa-zipformer-bilingual-zh-en
```

VoiceStudio 的 Sherpa 流式识别会在说话过程中持续返回 partial，并在端点处返回 `final_kind=utterance`。应用只在同一轮接受第一个有效 final，忽略 EOF 的 `summary`，避免同一句话触发两次回答。

### 2. 缩短首段等待

```dotenv
MODEL_REALTIME_FIRST_SEGMENT_CHARS=6
```

首段过短会让语气割裂，过长会拖慢首音频。6 字是在角色感和延迟之间的折中。

### 3. 复用 TTS 连接

一次实时回答只打开一条 VoiceStudio `/ws/tts`，同一连接连续发送多个短句请求。每个短句都重新 WebSocket 握手、重新解析音色与模型，会叠加几百毫秒到数秒的延迟。

### 4. VoiceStudio 启动参数

使用项目脚本：

```powershell
.\scripts\start-voicestudio.ps1
```

脚本固定：

```text
OMNIVOICE_STREAM_CHUNK=1200
OMNIVOICE_DICTATION_ENDPOINT_R1=0.8
OMNIVOICE_DICTATION_ENDPOINT_R2=0.45
HF_HUB_CACHE=<你的模型缓存目录>
```

`1200` 采样点在 24kHz 下约 50ms 一块，能在不增加明显 WebSocket 开销的情况下降低首音频粒度。

## 实测结果

环境：Windows、RTX 4060 Laptop、VoiceStudio 0.5.6、Sherpa 双语流式识别、自选音色。

热模型下一轮“说完”之后的观测值：

| 指标 | 当前实测 |
| --- | ---: |
| 识别 final | 约 1.5s |
| 首 token | 取决于所接入的模型服务 |
| VoiceStudio 首音频 | 约 1.2–1.5s |
| TTS 合成速度 | RTF 约 0.29–0.59 |

其中模型服务侧首 token 是当前最大的不可控项。代码侧已经不能通过继续压缩本地 ASR 或 TTS 解决这部分等待。

## 后续可继续做

1. 更换支持更低首 token 延迟的同价位模型，或增加可切换的模型配置。
2. 增加“本地小模型先接一句、远端模型继续生成”的草稿模式。
3. 在模型支持时加入 `prompt caching`，让固定人设和关系上下文命中缓存。
4. 把打断信号直接传给模型流和 TTS 流，减少被取消分段的资源浪费。
