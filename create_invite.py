#!/usr/bin/env python3
"""
Generates a single-use invite code and stores it in the database.
Run from the project root:  python create_invite.py

The generated code can then be shared with someone who should register at /register.
"""
import secrets
from database import get_db_connection, init_db

# Unambiguous characters — no I, O, 0, 1 to avoid confusion
_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'


def generate_code():
    part1 = ''.join(secrets.choice(_CHARS) for _ in range(4))
    part2 = ''.join(secrets.choice(_CHARS) for _ in range(4))
    return f'{part1}-{part2}'


def main():
    init_db()
    code = generate_code()
    conn = get_db_connection()
    try:
        conn.execute('INSERT INTO invite_codes (code) VALUES (%s)', (code,))
        conn.commit()
        print(f'\nInvite code: {code}')
        print('Share this with the person you want to invite.')
        print('They can use it at /register to create an account.')
    except Exception as e:
        print(f'Error: {e}')
    finally:
        conn.close()


if __name__ == '__main__':
    main()
