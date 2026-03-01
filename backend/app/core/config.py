import os
import secrets
import logging
from pydantic_settings import BaseSettings
from typing import List, Optional

logger = logging.getLogger(__name__)


ENV_PRODUCTION = os.getenv("ENVIRONMENT", "development").lower() == "production"


class Settings(BaseSettings):
    
    environment: str = "development"
    server_host: str = "0.0.0.0"
    port: int = 8001
    
    
    mongodb_uri: str = "mongodb://localhost:27017"
    db_name: str = "aura"
    
    
    firebase_credentials_path: str = "./firebase-credentials.json"
    firebase_project_id: str = ""
    
    
    groq_api_key: str = ""
    
    nvidia_api_key: str = ""
    
    
    secret_key: Optional[str] = None
    
    
    cors_origins: str = "http://localhost:8081,http://localhost:19006"

    @property
    def cors_list(self) -> List[str]:
        return [o.strip() for o in self.cors_origins.split(",")]

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._validate_production_settings()

    def _validate_production_settings(self):
        if ENV_PRODUCTION:
            if not self.secret_key:
                raise ValueError(
                    "SECRET_KEY environment variable must be set in production. "
                    "Generate a secure key using: python -c \"import secrets; print(secrets.token_urlsafe(32))\""
                )
            if not self.groq_api_key:
                logger.warning(
                    "GROQ_API_KEY is not set. AI-powered features will be disabled."
                )
        else:
            
            if not self.secret_key:
                self.secret_key = secrets.token_urlsafe(32)
                logger.warning(
                    "Using auto-generated SECRET_KEY for development. "
                    "Set SECRET_KEY environment variable for production."
                )

    class Config:
        env_file = ".env"


settings = Settings()
