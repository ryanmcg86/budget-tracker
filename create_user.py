#!/usr/bin/env python3
"""
Invite-only user creation script.
Run from the project root:  python create_user.py
"""
import bcrypt
import getpass
import sys
from database import get_db_connection, init_db

def main():
    init_db()
    print("=== Create new user ===")
    email = input("Email: ").strip().lower()
    if not email:
        print("Email required.")
        sys.exit(1)

    password = getpass.getpass("Password: ")
    confirm  = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Passwords do not match.")
        sys.exit(1)
    if len(password) < 8:
        print("Password must be at least 8 characters.")
        sys.exit(1)

    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt())
    conn = get_db_connection()
    try:
        conn.execute(
            'INSERT INTO users (email, password_hash) VALUES (?, ?)',
            (email, hashed)
        )
        conn.commit()
        print(f"\nUser '{email}' created successfully.")
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
    finally:
        conn.close()

if __name__ == '__main__':
    main()
