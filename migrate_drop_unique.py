"""
One-time migration: removes the UNIQUE(date, description, amount, card_name)
constraint from the transactions table, and ensures the plaid_transaction_id
column and its unique index exist.

Run once from your project root:
    python3 migrate_drop_unique.py

Safe to run multiple times — all steps are idempotent.
"""

import sqlite3

DB_PATH = 'budget.db'

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

print("Checking current schema...")
cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'")
current_sql = cur.fetchone()[0]

if 'UNIQUE(date, description, amount, card_name)' not in current_sql:
    print("UNIQUE constraint already removed — nothing to do.")
else:
    print("Removing UNIQUE(date, description, amount, card_name) constraint...")

    cur.execute("BEGIN")

    # Rename the old table
    cur.execute("ALTER TABLE transactions RENAME TO transactions_old")

    # Recreate without the UNIQUE constraint
    cur.execute('''
        CREATE TABLE transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date DATE NOT NULL,
            description TEXT NOT NULL,
            amount DECIMAL(10, 2) NOT NULL,
            category TEXT,
            bank_category TEXT,
            merchant TEXT,
            card_name TEXT,
            is_payment BOOLEAN DEFAULT 0,
            is_shared BOOLEAN DEFAULT 0,
            shared_with TEXT,
            payer TEXT DEFAULT "Me",
            reimbursement_amount DECIMAL(10, 2) DEFAULT 0,
            is_manual_category BOOLEAN DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            plaid_transaction_id TEXT
        )
    ''')

    # Copy all data across
    cur.execute("INSERT INTO transactions SELECT * FROM transactions_old")
    rows = cur.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
    print(f"Copied {rows} rows.")

    # Recreate indexes
    cur.execute("CREATE INDEX IF NOT EXISTS idx_transaction_date ON transactions(date)")
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS idx_plaid_txn_id
        ON transactions(plaid_transaction_id)
        WHERE plaid_transaction_id IS NOT NULL
    """)

    # Drop old table
    cur.execute("DROP TABLE transactions_old")

    conn.commit()
    print("Done. UNIQUE constraint removed successfully.")

# Also ensure plaid_transaction_id column exists (in case it was missed earlier)
try:
    cur.execute("ALTER TABLE transactions ADD COLUMN plaid_transaction_id TEXT")
    print("Added plaid_transaction_id column.")
except sqlite3.OperationalError:
    print("plaid_transaction_id column already exists.")

# Ensure the unique index on plaid_transaction_id exists
cur.execute("""
    CREATE UNIQUE INDEX IF NOT EXISTS idx_plaid_txn_id
    ON transactions(plaid_transaction_id)
    WHERE plaid_transaction_id IS NOT NULL
""")
print("plaid_transaction_id index confirmed.")

conn.commit()
conn.close()
print("\nMigration complete. You can delete this file.")