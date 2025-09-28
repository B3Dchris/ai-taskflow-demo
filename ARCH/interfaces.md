# Interface Definitions - TaskFlow API

## Module: database
### File: SRC/database/models.py

```python
class User(Base):
    """User model for authentication
    Preconditions: email must be unique, password must be hashed
    Postconditions: user object with secure password storage
    """
    pass

class Task(Base):
    """Task model for task management
    Preconditions: user_id must exist, title required, status valid enum
    Postconditions: task object linked to user
    """
    pass
```

### File: SRC/database/connection.py

```python
def get_db() -> Generator[Session, None, None]:
    """Database session generator
    Preconditions: database connection available
    Postconditions: yields active database session, closes on completion
    Raises: DatabaseConnectionError
    """
    pass

def init_db() -> None:
    """Initialize database tables
    Preconditions: database file writable
    Postconditions: all tables created
    Raises: DatabaseInitError
    """
    pass
```

## Module: auth
### File: SRC/auth/service.py

```python
def register_user(email: str, password: str) -> User:
    """Register new user with email and password
    Preconditions: email unique, password meets requirements
    Postconditions: user created in database with hashed password
    Raises: UserExistsError, ValidationError
    """
    pass

def login_user(email: str, password: str) -> str:
    """Authenticate user and return JWT token
    Preconditions: user exists, password correct
    Postconditions: valid JWT token returned
    Raises: AuthenticationError
    """
    pass

def validate_token(token: str) -> User:
    """Validate JWT token and return user
    Preconditions: token format valid
    Postconditions: user object if token valid
    Raises: TokenExpiredError, InvalidTokenError
    """
    pass
```

### File: SRC/auth/utils.py

```python
def hash_password(password: str) -> str:
    """Hash password using bcrypt
    Preconditions: password is string
    Postconditions: bcrypt hashed password
    """
    pass

def verify_password(password: str, hashed: str) -> bool:
    """Verify password against hash
    Preconditions: password and hash are strings
    Postconditions: True if password matches
    """
    pass

def create_jwt_token(user_id: int) -> str:
    """Create JWT token for user
    Preconditions: user_id is valid integer
    Postconditions: signed JWT token with expiration
    """
    pass
```

## Module: tasks
### File: SRC/tasks/service.py

```python
def create_task(user_id: int, task_data: dict) -> Task:
    """Create new task for user
    Preconditions: user_id exists, task_data validated
    Postconditions: task created and saved to database
    Raises: ValidationError, UserNotFoundError
    """
    pass

def get_user_tasks(user_id: int, status: str = None, priority: str = None) -> List[Task]:
    """Get all tasks for user with optional filtering
    Preconditions: user_id exists
    Postconditions: list of user's tasks, empty list if none
    """
    pass

def get_task_by_id(task_id: int, user_id: int) -> Task:
    """Get specific task by ID for user
    Preconditions: task_id and user_id exist
    Postconditions: task object if user owns it
    Raises: TaskNotFoundError, UnauthorizedError
    """
    pass

def update_task(task_id: int, user_id: int, updates: dict) -> Task:
    """Update task with new data
    Preconditions: task exists, user owns task, updates validated
    Postconditions: task updated in database
    Raises: TaskNotFoundError, UnauthorizedError, ValidationError
    """
    pass

def delete_task(task_id: int, user_id: int) -> bool:
    """Delete task by ID
    Preconditions: task exists, user owns task
    Postconditions: task removed from database
    Raises: TaskNotFoundError, UnauthorizedError
    """
    pass

def search_tasks(user_id: int, query: str) -> List[Task]:
    """Search tasks by title or description
    Preconditions: user_id exists, query is string
    Postconditions: list of matching tasks
    """
    pass
```

## Module: api
### File: SRC/api/auth_routes.py

```python
@router.post("/register")
async def register(user_data: UserCreate) -> UserResponse:
    """Register new user endpoint
    Preconditions: valid user data in request
    Postconditions: user created, success response
    Raises: HTTP 400 for validation errors, HTTP 409 for existing user
    """
    pass

@router.post("/login") 
async def login(credentials: UserLogin) -> TokenResponse:
    """User login endpoint
    Preconditions: valid credentials in request
    Postconditions: JWT token returned
    Raises: HTTP 401 for invalid credentials
    """
    pass
```

### File: SRC/api/task_routes.py

```python
@router.post("/tasks")
async def create_task(task_data: TaskCreate, current_user: User = Depends(get_current_user)) -> TaskResponse:
    """Create new task endpoint
    Preconditions: authenticated user, valid task data
    Postconditions: task created and returned
    Raises: HTTP 400 for validation errors
    """
    pass

@router.get("/tasks")
async def list_tasks(status: str = None, priority: str = None, current_user: User = Depends(get_current_user)) -> List[TaskResponse]:
    """List user tasks endpoint
    Preconditions: authenticated user
    Postconditions: list of user's tasks returned
    """
    pass

@router.get("/tasks/{task_id}")
async def get_task(task_id: int, current_user: User = Depends(get_current_user)) -> TaskResponse:
    """Get specific task endpoint
    Preconditions: authenticated user, task exists and owned by user
    Postconditions: task returned
    Raises: HTTP 404 if task not found, HTTP 403 if not owned
    """
    pass

@router.put("/tasks/{task_id}")
async def update_task(task_id: int, updates: TaskUpdate, current_user: User = Depends(get_current_user)) -> TaskResponse:
    """Update task endpoint
    Preconditions: authenticated user, task exists and owned by user
    Postconditions: updated task returned
    Raises: HTTP 404 if task not found, HTTP 403 if not owned
    """
    pass

@router.delete("/tasks/{task_id}")
async def delete_task(task_id: int, current_user: User = Depends(get_current_user)) -> dict:
    """Delete task endpoint
    Preconditions: authenticated user, task exists and owned by user
    Postconditions: task deleted, success message returned
    Raises: HTTP 404 if task not found, HTTP 403 if not owned
    """
    pass
```
