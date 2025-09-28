"""Unit tests for authentication service."""

import pytest
from unittest.mock import Mock, patch
from datetime import datetime, timedelta

# These imports will fail initially - that's the point of TDD!
try:
    from SRC.auth.service import register_user, login_user, validate_token
    from SRC.auth.utils import hash_password, verify_password, create_jwt_token
    from SRC.database.models import User
    from SRC.shared.exceptions import UserExistsError, AuthenticationError, TokenExpiredError, InvalidTokenError
except ImportError:
    # Expected to fail initially
    register_user = None
    login_user = None
    validate_token = None
    hash_password = None
    verify_password = None
    create_jwt_token = None
    User = None
    UserExistsError = None
    AuthenticationError = None
    TokenExpiredError = None
    InvalidTokenError = None


@pytest.mark.unit
@pytest.mark.auth
@pytest.mark.skipif(register_user is None, reason="Auth service not implemented yet")
class TestUserRegistration:
    """Test cases for user registration."""
    
    def test_register_user_success(self, db_session):
        """Test successful user registration with valid data."""
        # Happy path test
        email = "newuser@example.com"
        password = "securepassword123"
        
        user = register_user(email, password, db_session)
        
        assert user.id is not None
        assert user.email == email
        assert user.password_hash != password  # Should be hashed
        assert user.created_at is not None
    
    def test_register_user_duplicate_email(self, db_session):
        """Test registration fails with duplicate email (edge case)."""
        email = "duplicate@example.com"
        password = "password123"
        
        # Register first user
        register_user(email, password, db_session)
        
        # Try to register second user with same email
        with pytest.raises(UserExistsError):
            register_user(email, "differentpassword", db_session)
    
    def test_register_user_email_normalization(self, db_session):
        """Test email normalization during registration (edge case)."""
        email1 = "Test@Example.COM"
        email2 = "test@example.com"
        
        user1 = register_user(email1, "password1", db_session)
        
        # Should normalize to lowercase
        assert user1.email == email2
    
    def test_register_user_invalid_email(self, db_session):
        """Test registration fails with invalid email (negative case)."""
        with pytest.raises(ValueError):
            register_user("invalid-email", "password123", db_session)


@pytest.mark.unit
@pytest.mark.auth
@pytest.mark.skipif(login_user is None, reason="Auth service not implemented yet")
class TestUserLogin:
    """Test cases for user login."""
    
    def test_login_user_success(self, db_session):
        """Test successful login with correct credentials."""
        email = "logintest@example.com"
        password = "testpassword123"
        
        # Register user first
        register_user(email, password, db_session)
        
        # Login should return JWT token
        token = login_user(email, password, db_session)
        
        assert token is not None
        assert isinstance(token, str)
        assert len(token) > 20  # JWT tokens are long
    
    def test_login_user_wrong_password(self, db_session):
        """Test login fails with wrong password (edge case)."""
        email = "wrongpass@example.com"
        password = "correctpassword"
        
        register_user(email, password, db_session)
        
        with pytest.raises(AuthenticationError):
            login_user(email, "wrongpassword", db_session)
    
    def test_login_user_nonexistent_email(self, db_session):
        """Test login fails with non-existent email (edge case)."""
        with pytest.raises(AuthenticationError):
            login_user("nonexistent@example.com", "password", db_session)
    
    def test_login_user_empty_credentials(self, db_session):
        """Test login fails with empty credentials (negative case)."""
        with pytest.raises(ValueError):
            login_user("", "", db_session)


@pytest.mark.unit
@pytest.mark.auth
@pytest.mark.skipif(validate_token is None, reason="Auth service not implemented yet")
class TestTokenValidation:
    """Test cases for JWT token validation."""
    
    def test_validate_token_success(self, db_session):
        """Test successful token validation."""
        email = "tokentest@example.com"
        password = "password123"
        
        # Register and login to get token
        user = register_user(email, password, db_session)
        token = login_user(email, password, db_session)
        
        # Validate token should return user
        validated_user = validate_token(token, db_session)
        
        assert validated_user.id == user.id
        assert validated_user.email == user.email
    
    def test_validate_token_expired(self, db_session):
        """Test validation fails with expired token (edge case)."""
        # Create expired token (this will be mocked)
        with patch('SRC.auth.utils.jwt.decode') as mock_decode:
            import jwt
            mock_decode.side_effect = jwt.ExpiredSignatureError("Token expired")
            
            with pytest.raises(TokenExpiredError):
                validate_token("expired_token", db_session)
    
    def test_validate_token_invalid_format(self, db_session):
        """Test validation fails with invalid token format (edge case)."""
        with pytest.raises(InvalidTokenError):
            validate_token("invalid.token.format", db_session)
    
    def test_validate_token_empty(self, db_session):
        """Test validation fails with empty token (negative case)."""
        with pytest.raises(ValueError):
            validate_token("", db_session)


@pytest.mark.unit
@pytest.mark.auth
@pytest.mark.skipif(hash_password is None, reason="Auth utils not implemented yet")
class TestAuthUtils:
    """Test cases for authentication utilities."""
    
    def test_hash_password_creates_hash(self):
        """Test password hashing creates different hash from original."""
        password = "testpassword123"
        hashed = hash_password(password)
        
        assert hashed != password
        assert len(hashed) > 20  # Bcrypt hashes are long
        assert hashed.startswith('$2b$')  # Bcrypt prefix
    
    def test_verify_password_correct(self):
        """Test password verification with correct password (edge case)."""
        password = "correctpassword"
        hashed = hash_password(password)
        
        assert verify_password(password, hashed) is True
    
    def test_verify_password_incorrect(self):
        """Test password verification with incorrect password (edge case)."""
        password = "correctpassword"
        hashed = hash_password(password)
        
        assert verify_password("wrongpassword", hashed) is False
    
    def test_create_jwt_token_format(self):
        """Test JWT token creation returns valid format (negative case)."""
        user_id = 123
        token = create_jwt_token(user_id)
        
        assert isinstance(token, str)
        assert len(token.split('.')) == 3  # JWT has 3 parts
        
        # Token should contain user_id when decoded (basic check)
        # Full JWT validation will be tested in integration tests
