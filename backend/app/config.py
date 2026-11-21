from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: str = "production"
    host: str = "127.0.0.1"
    port: int = 8000

    data_root: Path = Path("./data")
    database_url: str = "sqlite+aiosqlite:///./data/study_diary.db"

    deepseek_api_key: str
    deepseek_tools_origin: str = "https://api.deepseek.com"

    minio_endpoint: str = "127.0.0.1:9000"
    minio_access_key: str = "studydiary"
    minio_secret_key: str = ""
    minio_bucket: str = "study-diary"
    minio_secure: bool = False

    dsh_bin: str = "dsh"
    dsh_timeout_sec: int = 240
    idle_auto_pause_sec: int = 5400
    admin_token: str = ""

    default_child_id: str = "child_demo"
    default_child_name: str = "星莓同学"
    default_child_birth_date: str = "2017-09-01"
    default_child_gender: str = "女"
    default_child_age: int = 9
    default_child_grade: str = "小学四年级"
    test_base_url: str = "http://127.0.0.1:8000"


settings = Settings()
