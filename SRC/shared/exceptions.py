"""Custom exceptions for TaskFlow API."""


class TaskFlowError(Exception):
    """Base exception for TaskFlow API."""
    pass


class AuthenticationError(TaskFlowError):
    """Raised when authentication fails."""
    pass


class UserExistsError(TaskFlowError):
    """Raised when trying to create a user that already exists."""
    pass


class UserNotFoundError(TaskFlowError):
    """Raised when user is not found."""
    pass


class TokenExpiredError(AuthenticationError):
    """Raised when JWT token has expired."""
    pass


class InvalidTokenError(AuthenticationError):
    """Raised when JWT token is invalid."""
    pass


class TaskNotFoundError(TaskFlowError):
    """Raised when task is not found."""
    pass


class UnauthorizedError(TaskFlowError):
    """Raised when user is not authorized to perform action."""
    pass


class ValidationError(TaskFlowError):
    """Raised when input validation fails."""
    pass


class DatabaseConnectionError(TaskFlowError):
    """Raised when database connection fails."""
    pass


class DatabaseInitError(TaskFlowError):
    """Raised when database initialization fails."""
    pass
