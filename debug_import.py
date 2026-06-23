"""
Temporary debug script — run from your project root to diagnose why
duplicate Plaid transactions aren't being inserted.

    python3 debug_import.py

Delete after use.
"""

import sqlite3

DB_PATH = 'budget.db'
conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

print("=== 1. Current table schema ===")
cur.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'")
print(cur.fetchone()[0])

print("\n=== 2. Indexes on transactions ===")
cur.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='transactions'")
for row in cur.fetchall():
    print(row[0])

print("\n=== 3. Sample of plaid_transaction_id values (last 10 rows) ===")
cur.execute("SELECT id, date, description, amount, card_name, plaid_transaction_id FROM transactions ORDER BY id DESC LIMIT 10")
for row in cur.fetchall():
    print(dict(row))

print("\n=== 4. How many rows have a plaid_transaction_id? ===")
cur.execute("SELECT COUNT(*) FROM transactions WHERE plaid_transaction_id IS NOT NULL")
print(cur.fetchone()[0])

print("\n=== 5. Simulate inserting a known duplicate ===")
# Change these values to match one of the transactions that failed to import
TEST_DATE = '2026-06-17'         # <-- update this
TEST_DESC = 'HEADWAY'            # <-- update this
TEST_AMT  = 20.00                # <-- update this
TEST_CARD = 'Chase'              # <-- update this
TEST_PLAID_ID = 'fake_test_id_999'

# Check if a matching row exists with no plaid_transaction_id
cur.execute('''
    SELECT id, date, description, amount, card_name, plaid_transaction_id
    FROM transactions
    WHERE date = ? AND description = ? AND amount = ? AND card_name = ?
    AND plaid_transaction_id IS NULL
    LIMIT 5
''', (TEST_DATE, TEST_DESC, TEST_AMT, TEST_CARD))
matches = cur.fetchall()
print(f"Existing rows matching (date/desc/amt/card) with no plaid ID: {len(matches)}")
for m in matches:
    print(" ", dict(m))

# Try the actual insert
try:
    cur.execute('''
        INSERT INTO transactions
            (date, description, merchant, amount, category, bank_category,
             card_name, is_payment, plaid_transaction_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plaid_transaction_id) DO NOTHING
    ''', (TEST_DATE, TEST_DESC, '', TEST_AMT, '', '', TEST_CARD, 0, TEST_PLAID_ID))
    print(f"INSERT result: lastrowid={cur.lastrowid}, rowcount={cur.rowcount}")
except Exception as e:
    print(f"INSERT failed with exception: {type(e).__name__}: {e}")

conn.rollback()  # don't actually save the test row
conn.close()
print("\nDone (no changes saved).")