"""Application configuration settings."""

import os
from typing import Optional


class Settings:
    """Application settings loaded from environment variables."""

    JWT_SECRET_KEY: str = os.getenv("JWT_SECRET_KEY", "dev-secret-key-change-in-production")
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite:///./taskflow.db")
    ENVIRONMENT: str = os.getenv("ENVIRONMENT", "development")

    @property
    def is_production(self) -> bool:
        """Check if running in production environment."""
        return self.ENVIRONMENT == "production"

    @property
    def is_development(self) -> bool:
        """Check if running in development environment."""
        return self.ENVIRONMENT == "development"

    @property
    def debug(self) -> bool:
        """Enable debug mode in non-production environments."""
        return not self.is_production


settings = Settings()