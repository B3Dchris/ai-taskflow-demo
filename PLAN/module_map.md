# Module Map - TaskFlow API

## auth
- **Owns:** auth.register, auth.login, auth.validate
- **Public API:** 
  - `register_user(email, password) -> User`
  - `login_user(email, password) -> JWT`
  - `validate_token(token) -> User`
- **Depends on:** database (User model)
- **Owner:** Dev Agent

## tasks  
- **Owns:** tasks.create, tasks.list, tasks.get, tasks.update, tasks.delete, tasks.filter, tasks.search
- **Public API:**
  - `create_task(user_id, task_data) -> Task`
  - `get_user_tasks(user_id, filters) -> List[Task]`
  - `get_task_by_id(task_id, user_id) -> Task`
  - `update_task(task_id, user_id, updates) -> Task`
  - `delete_task(task_id, user_id) -> bool`
- **Depends on:** database (Task model), auth (user validation)
- **Owner:** Dev Agent

## database
- **Owns:** database.models, database.connection, database.migrations
- **Public API:**
  - `User` model class
  - `Task` model class  
  - `get_db() -> Session`
  - `init_db() -> None`
- **Depends on:** None (foundation module)
- **Owner:** Dev Agent

## api
- **Owns:** HTTP endpoints, request/response handling, middleware
- **Public API:** FastAPI application with all endpoints
- **Depends on:** auth, tasks, database
- **Owner:** Dev Agent

## Module Boundaries
- **auth** handles only authentication logic, no business logic
- **tasks** contains all task-related business logic
- **database** provides data access layer only
- **api** handles HTTP concerns only, delegates to service modules
