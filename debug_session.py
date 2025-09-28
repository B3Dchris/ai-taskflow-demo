"""Debug script for session cleanup issue."""

import sys
sys.path.append('.')

from SRC.database.connection import get_db

def debug_session_lifecycle():
    """Debug the session cleanup behavior."""
    print("=== Session Lifecycle Debug ===")
    
    # Test current behavior
    print("\n1. Testing current get_db() behavior:")
    db_gen = get_db()
    db_session = next(db_gen)
    
    print(f"   Session created: {db_session}")
    print(f"   Session active before close: {db_session.is_active}")
    print(f"   Session ID: {id(db_session)}")
    
    # Try different cleanup approaches
    print("\n2. Testing generator close:")
    try:
        db_gen.close()
        print(f"   Session active after gen.close(): {db_session.is_active}")
    except Exception as e:
        print(f"   Error during gen.close(): {e}")
    
    # Test manual session close
    print("\n3. Testing manual session close:")
    if db_session.is_active:
        db_session.close()
        print(f"   Session active after manual close(): {db_session.is_active}")
    
    print("\n4. Testing with context manager approach:")
    try:
        with get_db() as db:
            print(f"   Context session active: {db.is_active}")
        print(f"   Context session after exit: {db.is_active}")
    except Exception as e:
        print(f"   Context manager not supported: {e}")
    
    print("\n5. Testing proper generator usage:")
    db_gen2 = get_db()
    db_session2 = next(db_gen2)
    print(f"   New session active: {db_session2.is_active}")
    
    # Properly exhaust generator
    try:
        next(db_gen2)
    except StopIteration:
        print("   Generator properly exhausted")
    
    print(f"   Session active after StopIteration: {db_session2.is_active}")

if __name__ == "__main__":
    debug_session_lifecycle()
