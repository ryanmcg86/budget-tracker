import sqlite3
from datetime import datetime

DB_NAME = 'budget.db'

# Default seed list — used only to populate the categories table on first run.
# The live source of truth is the categories table; call get_categories() instead.
DEFAULT_CATEGORIES = [
    'Streaming',
    'Transportation',
    'Food/Drink',
    'Travel',
    'Utilities',
    'Party',
    'Wellness',
    'Entertainment',
    'Investing',
    'Miscellaneous/Infrequent'
]

# Legacy alias so any import of TRACKED_CATEGORIES still works until fully migrated.
TRACKED_CATEGORIES = DEFAULT_CATEGORIES


def get_categories(user_id=1):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT name FROM categories WHERE user_id = ? ORDER BY display_order, id', (user_id,))
    rows = cursor.fetchall()
    conn.close()
    return [r['name'] for r in rows]

def get_db_connection():
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Initialize the database with required tables"""
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            email         TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name  TEXT,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    try:
        cursor.execute('ALTER TABLE users ADD COLUMN display_name TEXT')
    except sqlite3.OperationalError:
        pass
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS transactions (
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
            payer TEXT DEFAULT "Me",
            reimbursement_amount DECIMAL(10, 2) DEFAULT 0,
            is_manual_category BOOLEAN DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            plaid_transaction_id TEXT
        )
    ''')

    # 2. Migration: Add bank_category column if it's missing (for existing databases)
    try:
        cursor.execute('ALTER TABLE transactions ADD COLUMN bank_category TEXT')
    except sqlite3.OperationalError:
        pass # Column already exists

    # Add this column to your transactions table
    try:
        cursor.execute('ALTER TABLE transactions ADD COLUMN is_payment BOOLEAN DEFAULT 0')
    except:
        pass

    try:
        cursor.execute('ALTER TABLE category_rules ADD COLUMN amount DECIMAL(10, 2)')
    except:
        pass # Already exists

    # Migration: Add the new columns needed for Shared Expenses
    columns_to_add = [
        ('is_shared', 'BOOLEAN DEFAULT 0'),
        ('shared_with', 'TEXT'),
        ('payer', 'TEXT DEFAULT "Me"'),
        ('reimbursement_amount', 'DECIMAL(10, 2) DEFAULT 0'),
        ('is_manual_category', 'BOOLEAN DEFAULT 0')
    ]

    for col_name, col_type in columns_to_add:
        try:
            cursor.execute(f'ALTER TABLE transactions ADD COLUMN {col_name} {col_type}')
            print(f"Added column: {col_name}")
        except sqlite3.OperationalError:
            # This error happens if the column already exists, which is fine
            pass
    
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            parent_category TEXT
        )
    ''')
    # Migration: add display_order if missing
    try:
        cursor.execute('ALTER TABLE categories ADD COLUMN display_order INTEGER DEFAULT 0')
    except sqlite3.OperationalError:
        pass
    # Seed defaults if the table is empty
    cursor.execute('SELECT COUNT(*) FROM categories')
    if cursor.fetchone()[0] == 0:
        for i, name in enumerate(DEFAULT_CATEGORIES):
            cursor.execute('INSERT OR IGNORE INTO categories (name, display_order) VALUES (?, ?)', (name, i))
 
    # Create index on date for faster queries
    cursor.execute('''
        CREATE INDEX IF NOT EXISTS idx_transaction_date 
        ON transactions(date)
    ''')

    # Create the settlements table
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER NOT NULL,
        expense_id INTEGER NOT NULL,
        amount_applied DECIMAL(10, 2) NOT NULL,
        settled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (payment_id) REFERENCES transactions (id),
        FOREIGN KEY (expense_id) REFERENCES transactions (id)
    )
    ''')


#    cursor.execute('''
#    CREATE TABLE IF NOT EXISTS category_rules (
#        id INTEGER PRIMARY KEY AUTOINCREMENT,
#        keyword TEXT NOT NULL,
#        category TEXT NOT NULL,
#        amount DECIMAL(10, 2)
#    )
#''')

    cursor.execute('''
    CREATE TABLE IF NOT EXISTS transaction_shares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id INTEGER NOT NULL,
        person_name TEXT NOT NULL,
        share_amount DECIMAL(10, 2) NOT NULL,
        FOREIGN KEY (transaction_id) REFERENCES transactions (id)
    )
    ''')

    try:
        cursor.execute('ALTER TABLE settlements ADD COLUMN expense_share_id INTEGER')
        cursor.execute('ALTER TABLE settlements ADD COLUMN payment_share_id INTEGER')
    except:
        pass

    # Repair broken settlement links (one-time fix for data migration/ID churn)
    cursor.execute('''
        SELECT id, payment_id, expense_id 
        FROM settlements 
        WHERE payment_share_id IS NULL OR expense_share_id IS NULL
    ''')
    orphans = cursor.fetchall()
    for row in orphans:
        sid, pid, eid = row['id'], row['payment_id'], row['expense_id']
        
        # Match the payment share
        cursor.execute('SELECT id FROM transaction_shares WHERE transaction_id = ? LIMIT 1', (pid,))
        p_share = cursor.fetchone()
        
        # Match the expense share
        cursor.execute('SELECT id FROM transaction_shares WHERE transaction_id = ? LIMIT 1', (eid,))
        e_share = cursor.fetchone()
        
        if p_share and e_share:
            cursor.execute('''
                UPDATE settlements 
                SET payment_share_id = ?, expense_share_id = ? 
                WHERE id = ?
            ''', (p_share['id'], e_share['id'], sid))

    # Tag System Tables
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS transaction_tags (
            transaction_id INTEGER,
            tag_id INTEGER,
            PRIMARY KEY (transaction_id, tag_id),
            FOREIGN KEY (transaction_id) REFERENCES transactions (id),
            FOREIGN KEY (tag_id) REFERENCES tags (id)
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS tag_defaults (
            category TEXT,
            tag_id INTEGER,
            PRIMARY KEY (category, tag_id),
            FOREIGN KEY (tag_id) REFERENCES tags (id)
        )
    ''')

    # NEW: Cleanup orphaned settlements where the referenced shares no longer exist
    # This fixes the "ghost allocation" issue
    cursor.execute('''
        DELETE FROM settlements 
        WHERE payment_share_id NOT IN (SELECT id FROM transaction_shares)
           OR expense_share_id NOT IN (SELECT id FROM transaction_shares)
           OR payment_id NOT IN (SELECT id FROM transactions)
           OR expense_id NOT IN (SELECT id FROM transactions)
    ''')

    # Plaid integration: store the Plaid transaction ID so we can deduplicate on future syncs
    try:
        cursor.execute('ALTER TABLE transactions ADD COLUMN plaid_transaction_id TEXT')
        cursor.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_plaid_txn_id ON transactions(plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL')
    except sqlite3.OperationalError:
        pass

    # Applied date override: lets user re-attribute a transaction to a specific date for charting
    try:
        cursor.execute('ALTER TABLE transactions ADD COLUMN applied_date TEXT')
    except sqlite3.OperationalError:
        pass

    # Payment splits: divide a lump payment into date-specific portions for charting and ledger display
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS payment_splits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            transaction_id INTEGER NOT NULL,
            amount DECIMAL(10, 2) NOT NULL,
            applied_date TEXT NOT NULL,
            note TEXT,
            FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
        )
    ''')

    # Plaid integration: one row per connected bank account
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS plaid_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT UNIQUE NOT NULL,
            access_token TEXT NOT NULL,
            institution_name TEXT NOT NULL,
            account_name TEXT NOT NULL,
            account_id TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')

    cursor.execute('''
        CREATE TABLE IF NOT EXISTS breakdown_views (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            category TEXT NOT NULL,
            tag_ids TEXT NOT NULL,
            view_mode TEXT NOT NULL DEFAULT 'net',
            time_range TEXT NOT NULL DEFAULT '6m'
        )
    ''')

    # User isolation: add user_id to all user-scoped tables and backfill existing rows to user 1
    for _tbl in ['transactions', 'categories', 'settlements', 'transaction_shares',
                 'tags', 'tag_defaults', 'payment_splits', 'plaid_accounts', 'breakdown_views']:
        try:
            cursor.execute(f'ALTER TABLE {_tbl} ADD COLUMN user_id INTEGER REFERENCES users(id)')
        except sqlite3.OperationalError:
            pass
        cursor.execute(f'UPDATE {_tbl} SET user_id = 1 WHERE user_id IS NULL')

    conn.commit()
    conn.close()

    clean_account_names()


def insert_transactions(transactions, user_id=1):
    """
    Inserts a list of tuples into the transactions table.
    Each tuple: (date, description, amount, bank_category, bank_category, merchant, card_name, is_payment)
    Uses INSERT OR IGNORE so duplicate rows (same date/description/amount/card_name) are silently skipped.
    Returns the number of rows actually inserted.
    """
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.executemany('''
        INSERT OR IGNORE INTO transactions
            (date, description, amount, category, bank_category, merchant, card_name, is_payment, user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', [t + (user_id,) for t in transactions])

    inserted = cursor.rowcount
    conn.commit()
    conn.close()
    return inserted


def get_monthly_summary():
    """Get spending summary grouped by month"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute('''
        SELECT 
            strftime('%Y-%m', date) as month,
            COUNT(*) as transaction_count,
            SUM(amount) as total_spent,
            AVG(amount) as avg_transaction
        FROM transactions
        GROUP BY strftime('%Y-%m', date)
        ORDER BY month DESC
    ''')
    
    results = cursor.fetchall()
    conn.close()
    
    return [dict(row) for row in results]

def get_category_breakdown(start_date=None, end_date=None):
    """Get spending breakdown by category"""
    conn = get_db_connection()
    cursor = conn.cursor()
    
    query = '''
        SELECT 
            COALESCE(category, 'Uncategorized') as category,
            COUNT(*) as transaction_count,
            SUM(amount) as total_spent
        FROM transactions
    '''
    
    params = []
    if start_date and end_date:
        query += ' WHERE date BETWEEN ? AND ?'
        params = [start_date, end_date]
    
    query += ' GROUP BY category ORDER BY total_spent DESC'
    
    cursor.execute(query, params)
    results = cursor.fetchall()
    conn.close()
    
    return [dict(row) for row in results]

def get_all_transactions(limit=100):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # ENSURE is_shared is in this SELECT statement
    cursor.execute('''
        SELECT id, date, description, amount, category, bank_category, 
               merchant, card_name, is_payment, is_shared, payer, reimbursement_amount,
               (SELECT COUNT(*) FROM settlements s WHERE s.payment_id = transactions.id OR s.expense_id = transactions.id) as settlement_count
        FROM transactions 
        ORDER BY date DESC 
        LIMIT ?
    ''', (limit,))
    
    results = cursor.fetchall()
    conn.close()
    return [dict(row) for row in results]


def get_detailed_summary(year, month=None):
    """
    Returns a breakdown of the specific categories for a given month or the whole year.
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Base query for the year
    year_query = '''
        SELECT category, SUM(amount) as total, AVG(amount) as average
        FROM transactions 
        WHERE strftime('%Y', date) = ?
        GROUP BY category
    '''
    
    # Query for a specific month
    month_query = '''
        SELECT category, SUM(amount) as total
        FROM transactions 
        WHERE strftime('%Y', date) = ? AND strftime('%m', date) = ?
        GROUP BY category
    '''
    
    cursor.execute(year_query, (str(year),))
    year_data = {row['category']: dict(row) for row in cursor.fetchall()}
    
    month_data = {}
    if month:
        cursor.execute(month_query, (str(year), str(month).zfill(2)))
        month_data = {row['category']: dict(row) for row in cursor.fetchall()}
        
    conn.close()
    return {"year": year_data, "month": month_data}

#def add_rule(keyword, category, amount=None):
#    conn = get_db_connection()
#    cursor = conn.cursor()
#    if amount == '': amount = None
#    try:
#        cursor.execute('INSERT INTO category_rules (keyword, category, amount) VALUES (?, ?, ?)', 
#                       (keyword.upper(), category, amount))
#        conn.commit()
#    except sqlite3.IntegrityError:
#        pass # Rule already exists
#    conn.close()

#def get_all_rules():
#    conn = get_db_connection()
#    cursor = conn.cursor()
#    cursor.execute('SELECT * FROM category_rules ORDER BY category, keyword')
#    rules = cursor.fetchall()
#    conn.close()
#    return [dict(row) for row in rules]

#def apply_rules_to_all():
#    conn = get_db_connection()
#    cursor = conn.cursor()
#    
#    # 1. Reset everything to bank defaults
#    cursor.execute("UPDATE transactions SET category = bank_category")
#
#    # 2. Get all rules
#    # We sort so that rules WITHOUT an amount (NULL) come FIRST
#    # and rules WITH an amount come LAST to overwrite the general ones.
#    rules = get_all_rules()
#
#    sorted_rules = sorted(rules, key=lambda x: x['amount'] is not None)
#    
#    for rule in sorted_rules:
#        keyword = f"%{rule['keyword']}%"
#        category = rule['category']
#        amount = rule['amount']
#
#        if amount is not None:
#            # SPECIFIC MATCH: Description matches AND Amount matches (rounded to 2 decimals)
#            cursor.execute('''
#                UPDATE transactions 
#                SET category = ? 
#                WHERE UPPER(description) LIKE UPPER(?) 
#                AND ROUND(ABS(amount), 2) = ROUND(ABS(?), 2)
#            ''', (category, keyword, amount))
#        else:
#            # GENERAL MATCH: Description matches only
#            cursor.execute('''
#                UPDATE transactions 
#                SET category = ? 
#                WHERE UPPER(description) LIKE UPPER(?)
#            ''', (category, keyword))
#            
#    conn.commit()
#    conn.close()


def get_detailed_breakdown(year, month, user_id=1):
    conn = get_db_connection()
    cursor = conn.cursor()

    def fetch_data(yr, mo=None):
        sql = '''
            SELECT category,
                   -- GROSS: Cash you paid out (payer='Me' full amounts only)
                   SUM(CASE
                        WHEN payer = 'Me' THEN amount
                        ELSE 0
                   END) as gross,

                   -- NET: Your true obligation (your share of everything)
                   SUM(CASE
                        WHEN payer = 'Me' THEN (amount - COALESCE(reimbursement_amount, 0))
                        ELSE COALESCE(reimbursement_amount, 0)
                   END) as net
            FROM transactions
            WHERE strftime('%Y', COALESCE(applied_date, date)) = ? AND is_payment = 0 AND user_id = ?
        '''
        params = [yr, user_id]
        if mo:
            sql += " AND strftime('%m', COALESCE(applied_date, date)) = ?"
            params.append(mo)

        sql += " GROUP BY category"
        cursor.execute(sql, params)
        return {row['category']: {"gross": row['gross'] or 0, "net": row['net'] or 0} for row in cursor.fetchall()}

    month_totals = fetch_data(year, month)
    year_totals = fetch_data(year)

    # 1. Determine how many months have actually elapsed/recorded in this year
    cursor.execute("SELECT COUNT(DISTINCT strftime('%m', COALESCE(applied_date, date))) FROM transactions WHERE strftime('%Y', COALESCE(applied_date, date)) = ? AND is_payment = 0 AND user_id = ?", (year, user_id))
    months_in_year = cursor.fetchone()[0] or 1 # Avoid division by zero

    # 2. Averages logic: Total / months_in_year (consistent across all categories)
    cursor.execute('''
        SELECT category,
               SUM(CASE
                    WHEN payer = 'Me' THEN amount
                    ELSE 0
               END) / ? as gross_avg,
               SUM(CASE
                    WHEN payer = 'Me' THEN (amount - COALESCE(reimbursement_amount, 0))
                    ELSE COALESCE(reimbursement_amount, 0)
               END) / ? as net_avg
        FROM transactions
        WHERE strftime('%Y', COALESCE(applied_date, date)) = ? AND is_payment = 0 AND user_id = ?
        GROUP BY category
    ''', (months_in_year, months_in_year, year, user_id))
    year_averages = {row['category']: {"gross": row['gross_avg'] or 0, "net": row['net_avg'] or 0} for row in cursor.fetchall()}
    
    conn.close()
    return {
        "month_totals": month_totals,
        "year_totals": year_totals,
        "year_averages": year_averages
    }


def get_overview_history(year, month, view_mode='gross', time_range='1y', user_id=1):
    """
    Returns spending per month, broken down by category (within
    TRACKED_CATEGORIES), for a range of months ending at the given
    year/month. Powers the stacked bar graph on the Overview tab.

    Shape: {
        "months": ["Jan 2026", "Feb 2026", ...],
        "categories": { "Streaming": [12.99, 15.99, ...], "Food/Drink": [...], ... }
    }
    Each list under "categories" is parallel to "months".
    """
    from dateutil.relativedelta import relativedelta

    conn = get_db_connection()
    cursor = conn.cursor()

    if view_mode == 'gross':
        # Gross = cash you actually paid (payer='Me' only). Others-paid expenses aren't your cash outflow yet.
        amount_sql_case = "CASE WHEN payer = 'Me' THEN amount ELSE 0 END"
    else:
        # Net = your true obligation: your share of everything regardless of who paid upfront.
        amount_sql_case = "CASE WHEN payer = 'Me' THEN (amount - COALESCE(reimbursement_amount, 0)) ELSE COALESCE(reimbursement_amount, 0) END"

    end_date = datetime(int(year), int(month), 1)

    if time_range == '1m':
        start_date = end_date
    elif time_range == '3m':
        start_date = end_date - relativedelta(months=2)
    elif time_range == '6m':
        start_date = end_date - relativedelta(months=5)
    elif time_range == '5y':
        start_date = end_date - relativedelta(years=4, months=11)
    else:  # default to '1y'
        start_date = end_date - relativedelta(months=11)

    categories = get_categories(user_id)
    category_placeholders = ",".join(["?"] * len(categories))
    sql = f'''
        SELECT category, SUM({amount_sql_case}) as total FROM transactions
        WHERE strftime('%Y', COALESCE(applied_date, date)) = ? AND strftime('%m', COALESCE(applied_date, date)) = ?
        AND is_payment = 0 AND user_id = ? AND category IN ({category_placeholders})
        GROUP BY category
    '''

    months = []
    series = {cat: [] for cat in categories}

    current_date = start_date
    while current_date <= end_date:
        yr, mo = current_date.strftime('%Y'), current_date.strftime('%m')
        months.append(current_date.strftime('%b %Y'))

        cursor.execute(sql, (yr, mo, user_id, *categories))
        month_totals = {row['category']: row['total'] or 0 for row in cursor.fetchall()}

        for cat in categories:
            series[cat].append(month_totals.get(cat, 0))

        current_date += relativedelta(months=1)

    conn.close()
    return {'months': months, 'categories': series}


def clean_account_names():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. Update anything containing "Chase" to just "Chase"
    cursor.execute("UPDATE transactions SET card_name = 'Chase' WHERE card_name LIKE '%Chase%'")
    
    # 2. Update anything containing "Capital" or "Cap" to "Capital One"
    cursor.execute("UPDATE transactions SET card_name = 'Capital One' WHERE card_name LIKE '%Simply%'")
    
    # 3. You can add more here for Venmo, etc.
    cursor.execute("UPDATE transactions SET card_name = 'Venmo' WHERE card_name LIKE '%Venmo%'")

    conn.commit()
    conn.close()
    print("Account names cleaned successfully!")

def migrate_to_unique():
    from database import get_db_connection
    import sqlite3
    conn = get_db_connection()
    cursor = conn.cursor()
    
    try:
        # 1. Clean up any previous failed attempts
        cursor.execute('DROP TABLE IF EXISTS transactions_old')
        
        # 2. Rename the current table to a backup name
        cursor.execute('ALTER TABLE transactions RENAME TO transactions_old')
        
        # 3. Create the NEW table with all 15 columns and the UNIQUE constraint
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS transactions (
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
                UNIQUE(date, description, amount, card_name)
            )
        ''')
        
        # 4. Copy the data explicitly naming all 15 columns
        # This ensures the counts match perfectly
        cursor.execute('''
            INSERT OR IGNORE INTO transactions 
            (id, date, description, amount, category, bank_category, merchant, card_name, 
             is_payment, is_shared, shared_with, payer, reimbursement_amount, 
             is_manual_category, created_at)
            SELECT 
            id, date, description, amount, category, bank_category, merchant, card_name, 
            is_payment, is_shared, shared_with, payer, reimbursement_amount, 
            is_manual_category, created_at
            FROM transactions_old
        ''')
        
        # 5. Success! Drop the backup
        cursor.execute('DROP TABLE transactions_old')
        conn.commit()
        print("Deduplication migration successful!")
        
    except Exception as e:
        conn.rollback()
        print(f"Migration failed: {e}")
        # If it failed, try to bring back the original table
        try:
            cursor.execute('ALTER TABLE transactions_old RENAME TO transactions')
            conn.commit()
        except:
            pass
    finally:
        conn.close()