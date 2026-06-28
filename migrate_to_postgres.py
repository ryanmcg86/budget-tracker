#!/usr/bin/env python3
"""
migrate_to_postgres.py

Copies all data from the local SQLite budget.db into a PostgreSQL database.
Run once after Render creates the managed Postgres instance and the app has
started at least once (so init_db() has created all the tables).

Usage:
    DATABASE_URL=postgresql://user:pass@host/db python migrate_to_postgres.py

The script is safe to re-run: it uses ON CONFLICT DO NOTHING so existing rows
are skipped. It will warn you if the destination already has data.
"""

import os
import sqlite3
import sys

DB_NAME = os.path.join(os.path.dirname(__file__), 'budget.db')

# Migration order respects foreign-key dependencies.
TABLES = [
    'users',
    'categories',
    'tags',
    'transactions',
    'transaction_shares',
    'settlements',
    'transaction_tags',
    'tag_defaults',
    'payment_splits',
    'plaid_accounts',
    'breakdown_views',
]

# These tables have a SERIAL id; sequences need resetting after bulk insert.
SERIAL_TABLES = [
    'users', 'categories', 'tags', 'transactions',
    'transaction_shares', 'settlements', 'payment_splits',
    'plaid_accounts', 'breakdown_views',
]


def get_pg_conn():
    try:
        import psycopg2
    except ImportError:
        print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
        sys.exit(1)

    url = os.environ.get('DATABASE_URL', '').strip()
    if not url:
        print("ERROR: DATABASE_URL environment variable is not set.")
        print("  Set it to your Render PostgreSQL connection string and re-run.")
        sys.exit(1)
    if url.startswith('postgres://'):
        url = url.replace('postgres://', 'postgresql://', 1)
    try:
        return psycopg2.connect(url)
    except Exception as e:
        print(f"ERROR: Could not connect to PostgreSQL: {e}")
        sys.exit(1)


def get_sqlite_conn():
    if not os.path.exists(DB_NAME):
        print(f"ERROR: SQLite database not found at {DB_NAME}")
        sys.exit(1)
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn


def pg_columns(pg_cur, table):
    """Return the ordered column list from PostgreSQL's information_schema."""
    pg_cur.execute("""
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = %s
        ORDER BY ordinal_position
    """, (table,))
    return [row[0] for row in pg_cur.fetchall()]


def migrate_table(sq_conn, pg_cur, table):
    cols = pg_columns(pg_cur, table)
    if not cols:
        print(f"  {table}: not found in PostgreSQL — skipping")
        return 0

    # Fetch only the columns PostgreSQL knows about (guards against stale SQLite extras)
    col_list = ', '.join(cols)
    try:
        sq_rows = sq_conn.execute(f'SELECT {col_list} FROM {table}').fetchall()
    except sqlite3.OperationalError as e:
        print(f"  {table}: SQLite error ({e}) — skipping")
        return 0

    if not sq_rows:
        print(f"  {table}: 0 rows")
        return 0

    placeholders = ', '.join(['%s'] * len(cols))
    insert_sql = (
        f'INSERT INTO {table} ({col_list}) VALUES ({placeholders}) ON CONFLICT DO NOTHING'
    )

    inserted = 0
    for row in sq_rows:
        values = []
        for col in cols:
            val = row[col]
            # SQLite stores bcrypt hashes as bytes (BLOB); PostgreSQL needs str.
            if col == 'password_hash' and isinstance(val, bytes):
                val = val.decode('utf-8')
            values.append(val)
        pg_cur.execute(insert_sql, values)
        inserted += pg_cur.rowcount

    return inserted


def reset_sequences(pg_cur):
    """After bulk-inserting rows with explicit IDs, sync the SERIAL sequences."""
    for table in SERIAL_TABLES:
        pg_cur.execute(f"""
            SELECT setval(
                pg_get_serial_sequence('{table}', 'id'),
                COALESCE((SELECT MAX(id) FROM {table}), 1)
            )
        """)


def main():
    print("=== SQLite → PostgreSQL migration ===\n")

    sq_conn = get_sqlite_conn()
    pg_conn = get_pg_conn()
    pg_cur  = pg_conn.cursor()

    # Warn if destination already has transaction data
    pg_cur.execute('SELECT COUNT(*) FROM transactions')
    existing = pg_cur.fetchone()[0]
    if existing > 0:
        print(f"WARNING: PostgreSQL already contains {existing} transaction(s).")
        answer = input("Continue anyway? Existing rows will be skipped (ON CONFLICT DO NOTHING). [y/N] ").strip().lower()
        if answer != 'y':
            print("Aborted.")
            sq_conn.close()
            pg_conn.close()
            sys.exit(0)
        print()

    total = 0
    for table in TABLES:
        try:
            n = migrate_table(sq_conn, pg_cur, table)
            print(f"  {table}: {n} rows inserted")
            total += n
        except Exception as e:
            print(f"\nERROR migrating {table}: {e}")
            pg_conn.rollback()
            sq_conn.close()
            pg_conn.close()
            sys.exit(1)

    print("\nResetting PostgreSQL sequences...")
    try:
        reset_sequences(pg_cur)
    except Exception as e:
        print(f"WARNING: Could not reset sequences: {e}")
        print("  You may need to run this manually if inserts fail after migration.")

    pg_conn.commit()
    sq_conn.close()
    pg_conn.close()

    print(f"\nDone! {total} rows migrated successfully.")
    print("You can now deploy the app — it will use PostgreSQL automatically.")


if __name__ == '__main__':
    main()
