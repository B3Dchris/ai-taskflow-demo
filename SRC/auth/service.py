"""Authentication service for user registration and login."""

import re
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError

from ..database.models import User
from ..shared.exceptions import (
    UserExistsError, 
    AuthenticationError, 
    UserNotFoundError,
    ValidationError
)
from .utils import hash_password, verify_password, create_jwt_token, decode_jwt_token

# Email validation regex
EMAIL_REGEX = re.compile(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')


def register_user(email: str, password: str, db: Session) -> User:
    """Register new user with email and password.
    
    Preconditions: email unique, password meets requirements
    Postconditions: user created in database with hashed password
    Raises: UserExistsError, ValidationError
    """
    if not email or not password:
        raise ValueError("Email and password are required")
    
    # Normalize email to lowercase
    email = email.lower().strip()
    
    # Validate email format
    if not EMAIL_REGEX.match(email):
        raise ValueError("Invalid email format")
    
    # Validate password requirements
    if len(password) < 8:
        raise ValidationError("Password must be at least 8 characters long")
    
    # Check if user already exists
    existing_user = db.query(User).filter(User.email == email).first()
    if existing_user:
        raise UserExistsError(f"User with email {email} already exists")
    
    # Hash password and create user
    password_hash = hash_password(password)
    
    user = User(
        email=email,
        password_hash=password_hash
    )
    
    try:
        db.add(user)
        db.commit()
        db.refresh(user)
        return user
    except IntegrityError:
        db.rollback()
        raise UserExistsError(f"User with email {email} already exists")


def login_user(email: str, password: str, db: Session) -> str:
    """Authenticate user and return JWT token.
    
    Preconditions: user exists, password correct
    Postconditions: valid JWT token returned
    Raises: AuthenticationError
    """
    if not email or not password:
        raise ValueError("Email and password are required")
    
    # Normalize email
    email = email.lower().strip()
    
    # Find user by email
    user = db.query(User).filter(User.email == email).first()
    if not user:
        raise AuthenticationError("Invalid email or password")
    
    # Verify password
    if not verify_password(password, user.password_hash):
        raise AuthenticationError("Invalid email or password")
    
    # Create and return JWT token
    token = create_jwt_token(user.id)
    return token


def validate_token(token: str, db: Session) -> User:
    """Validate JWT token and return user.
    
    Preconditions: token format valid
    Postconditions: user object if token valid
    Raises: TokenExpiredError, InvalidTokenError
    """
    if not token:
        raise ValueError("Token is required")
    
    # Decode token to get user_id
    payload = decode_jwt_token(token)
    user_id = payload.get("user_id")
    
    if not user_id:
        raise InvalidTokenError("Token does not contain user_id")
    
    # Find user in database
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise UserNotFoundError(f"User with ID {user_id} not found")
    
    return user


def get_current_user(token: str, db: Session) -> User:
    """Get current user from JWT token (convenience function).
    
    This is a wrapper around validate_token for use in API endpoints.
    """
    return validate_token(token, db)
