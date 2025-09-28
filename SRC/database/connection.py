"""Database connection management for TaskFlow API."""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from typing import Generator
import os

from .models import Base
from ..config.settings import settings

# Create engine
engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in settings.DATABASE_URL else {},
    echo=settings.debug  # Enable SQL logging in development
)

# Create session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Generator[Session, None, None]:
    """Database session generator.
    
    Preconditions: database connection available
    Postconditions: yields active database session, closes on completion
    Raises: DatabaseConnectionError
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Initialize database tables.
    
    Preconditions: database file writable
    Postconditions: all tables created
    Raises: DatabaseInitError
    """
    Base.metadata.create_all(bind=engine)
