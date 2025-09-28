"""Database connection management for TaskFlow API."""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from typing import Generator
import os

from .models import Base

# Database configuration
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./taskflow.db")

# Create engine
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {}
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
