"""Authentication utilities for password hashing and JWT tokens."""

import bcrypt
from jose import jwt
from datetime import datetime, timedelta, timezone
from typing import Optional
import os

from ..shared.exceptions import TokenExpiredError, InvalidTokenError

# JWT Configuration
JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-key-change-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24


def hash_password(password: str) -> str:
    """Hash password using bcrypt.
    
    Preconditions: password is string
    Postconditions: bcrypt hashed password
    """
    if not password:
        raise ValueError("Password cannot be empty")
    
    # Generate salt and hash password
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode('utf-8'), salt)
    return hashed.decode('utf-8')


def verify_password(password: str, hashed: str) -> bool:
    """Verify password against hash.
    
    Preconditions: password and hash are strings
    Postconditions: True if password matches
    """
    if not password or not hashed:
        return False
    
    try:
        return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))
    except Exception:
        return False


def create_jwt_token(user_id: int) -> str:
    """Create JWT token for user.
    
    Preconditions: user_id is valid integer
    Postconditions: signed JWT token with expiration
    """
    if not user_id:
        raise ValueError("User ID cannot be empty")
    
    # Create payload with expiration
    now = datetime.now(timezone.utc)
    payload = {
        "user_id": user_id,
        "exp": now + timedelta(hours=JWT_EXPIRATION_HOURS),
        "iat": now
    }
    
    # Sign and return token
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token


def decode_jwt_token(token: str) -> dict:
    """Decode and validate JWT token.
    
    Preconditions: token format valid
    Postconditions: decoded payload if token valid
    Raises: TokenExpiredError, InvalidTokenError
    """
    if not token:
        raise ValueError("Token cannot be empty")
    
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise TokenExpiredError("Token has expired")
    except jwt.InvalidTokenError:
        raise InvalidTokenError("Invalid token format")
    except Exception as e:
        raise InvalidTokenError(f"Token validation failed: {str(e)}")
