from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "sqlite:///./data/assistant.db"
    api_host: str = "127.0.0.1"
    api_port: int = 8001
    database_auto_create: bool = False
    model_base_url: str = ""
    model_api_key: str = ""
    model_name: str = ""
    # Keep realtime voice on the lowest-latency model without changing text chat.
    model_realtime_name: str = ""
    model_realtime_max_tokens: int = 80
    model_realtime_history_messages: int = 6
    # Live calls should not pay for the full text-chat prompt on every turn.
    model_realtime_prompt_mode: str = "compact"
    model_realtime_first_segment_chars: int = 14
    asr_provider: str = "mock"
    asr_base_url: str = ""
    asr_api_key: str = ""
    asr_model: str = ""
    # Optional VoiceStudio Sherpa model for true streaming ASR.
    asr_realtime_model: str = ""
    tts_provider: str = "mock"
    tts_base_url: str = ""
    tts_api_key: str = ""
    tts_model: str = ""
    # 留空表示不指定音色，由 TTS 服务端使用默认音色。
    tts_voice: str = ""
    # VoiceStudio / OmniVoice iterative decoding steps. Lower is faster and
    # slightly less polished; the pipeline picks the tier per call site.
    tts_realtime_num_step: int = 8
    tts_chat_num_step: int = 8
    tts_manual_num_step: int = 12
    vision_provider: str = "mock"
    vision_base_url: str = ""
    vision_api_key: str = ""
    vision_model: str = ""
    attachment_dir: str = "./data/attachments"
    cors_origins: str = "http://localhost:5173"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
