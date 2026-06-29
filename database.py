import os
from datetime import datetime

DB_NAME = 'budget.db'
USE_POSTGRES = bool(os.getenv('DATABASE_URL'))

# Default seed list — used only to populate the categories table on first run.
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

# Legacy alias
TRACKED_CATEGORIES = DEFAULT_CATEGORIES


# ---------------------------------------------------------------------------
# Database connection wrappers
# SQLite uses '?' placeholders; PostgreSQL uses '%s'. All SQL in this codebase
# is written with '%s'. The SQLite wrapper converts them transparently.
# ---------------------------------------------------------------------------

class _SQLiteConn:
    def __init__(self, raw):
        self._raw = raw

    def cursor(self):
        return _SQLiteCursor(self._raw.cursor())

    def execute(self, sql, params=()):
        c = self.cursor()
        c.execute(sql, params)
        return c

    def commit(self):   self._raw.commit()
    def close(self):    self._raw.close()
    def rollback(self): self._raw.rollback()


class _SQLiteCursor:
    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql, params=()):
        self._raw.execute(sql.replace('%s', '?'), params)
        return self

    def executemany(self, sql, params):
        self._raw.executemany(sql.replace('%s', '?'), params)
        return self

    def fetchone(self):  return self._raw.fetchone()
    def fetchall(self):  return self._raw.fetchall()

    @property
    def rowcount(self):  return self._raw.rowcount

    @property
    def lastrowid(self): return self._raw.lastrowid

    def __iter__(self):  return iter(self._raw)


class _PGConn:
    def __init__(self, raw):
        self._raw = raw
        import psycopg2.extensions as _ext
        # Return DATE columns as "YYYY-MM-DD" strings, matching SQLite behaviour.
        _ext.register_type(
            _ext.new_type(_ext.DATE.values, 'DATE_AS_STR', lambda v, c: v),
            raw
        )

    def cursor(self):
        from psycopg2.extras import RealDictCursor
        return _PGCursor(self._raw.cursor(cursor_factory=RealDictCursor))

    def execute(self, sql, params=()):
        c = self.cursor()
        c.execute(sql, params)
        return c

    def commit(self):   self._raw.commit()
    def close(self):    self._raw.close()
    def rollback(self): self._raw.rollback()


class _PGCursor:
    def __init__(self, raw):
        self._raw = raw

    def execute(self, sql, params=()):
        self._raw.execute(sql, params)
        return self

    def executemany(self, sql, params):
        self._raw.executemany(sql, params)
        return self

    def fetchone(self):  return self._raw.fetchone()
    def fetchall(self):  return self._raw.fetchall()

    @property
    def rowcount(self):  return self._raw.rowcount

    @property
    def lastrowid(self):
        # Must be called immediately after an INSERT on a SERIAL column.
        self._raw.execute('SELECT lastval()')
        row = self._raw.fetchone()
        return row['lastval'] if row else None

    def __iter__(self):  return iter(self._raw)


def get_db_connection():
    if USE_POSTGRES:
        import psycopg2
        db_url = os.getenv('DATABASE_URL')
        if db_url.startswith('postgres://'):
            db_url = db_url.replace('postgres://', 'postgresql://', 1)
        return _PGConn(psycopg2.connect(db_url))
    else:
        import sqlite3
        raw = sqlite3.connect(DB_NAME)
        raw.row_factory = sqlite3.Row
        return _SQLiteConn(raw)


def get_categories(user_id=1):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT name FROM categories WHERE user_id = %s ORDER BY display_order, id', (user_id,))
    rows = cursor.fetchall()
    conn.close()
    return [r['name'] for r in rows]


def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()

    pk = 'SERIAL PRIMARY KEY' if USE_POSTGRES else 'INTEGER PRIMARY KEY AUTOINCREMENT'

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS users (
            id            {pk},
            email         TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name  TEXT,
            created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS transactions (
            id                   {pk},
            date                 DATE NOT NULL,
            description          TEXT NOT NULL,
            amount               DECIMAL(10, 2) NOT NULL,
            category             TEXT,
            bank_category        TEXT,
            merchant             TEXT,
            card_name            TEXT,
            is_payment           INTEGER DEFAULT 0,
            is_shared            INTEGER DEFAULT 0,
            shared_with          TEXT,
            payer                TEXT DEFAULT 'Me',
            reimbursement_amount DECIMAL(10, 2) DEFAULT 0,
            is_manual_category   INTEGER DEFAULT 0,
            created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            plaid_transaction_id TEXT,
            applied_date         TEXT,
            user_id              INTEGER REFERENCES users(id)
        )
    ''')
    conn.commit()

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS categories (
            id              {pk},
            name            TEXT UNIQUE NOT NULL,
            parent_category TEXT,
            display_order   INTEGER DEFAULT 0,
            user_id         INTEGER REFERENCES users(id)
        )
    ''')
    conn.commit()

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS settlements (
            id               {pk},
            payment_id       INTEGER NOT NULL,
            expense_id       INTEGER NOT NULL,
            amount_applied   DECIMAL(10, 2) NOT NULL,
            settled_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expense_share_id INTEGER,
            payment_share_id INTEGER,
            FOREIGN KEY (payment_id) REFERENCES transactions (id),
            FOREIGN KEY (expense_id) REFERENCES transactions (id)
        )
    ''')
    conn.commit()

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS transaction_shares (
            id             {pk},
            transaction_id INTEGER NOT NULL,
            person_name    TEXT NOT NULL,
            share_amount   DECIMAL(10, 2) NOT NULL,
            user_id        INTEGER REFERENCES users(id),
            FOREIGN KEY (transaction_id) REFERENCES transactions (id)
        )
    ''')
    conn.commit()

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS tags (
            id      {pk},
            name    TEXT UNIQUE NOT NULL,
            user_id INTEGER REFERENCES users(id)
        )
    ''')
    conn.commit()

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS transaction_tags (
            transaction_id INTEGER,
            tag_id         INTEGER,
            PRIMARY KEY (transaction_id, tag_id),
            FOREIGN KEY (transaction_id) REFERENCES transactions (id),
            FOREIGN KEY (tag_id) REFERENCES tags (id)
        )
    ''')
    conn.commit()

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS tag_defaults (
            category TEXT,
            tag_id   INTEGER,
            user_id  INTEGER REFERENCES users(id),
            PRIMARY KEY (category, tag_id),
            FOREIGN KEY (tag_id) REFERENCES tags (id)
        )
    ''')
    conn.commit()

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS payment_splits (
            id             {pk},
            transaction_id INTEGER NOT NULL,
            amount         DECIMAL(10, 2) NOT NULL,
            applied_date   TEXT NOT NULL,
            note           TEXT,
            FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE CASCADE
        )
    ''')
    conn.commit()

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS plaid_accounts (
            id               {pk},
            item_id          TEXT UNIQUE NOT NULL,
            access_token     TEXT NOT NULL,
            institution_name TEXT NOT NULL,
            account_name     TEXT NOT NULL,
            account_id       TEXT NOT NULL,
            created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            user_id          INTEGER REFERENCES users(id)
        )
    ''')
    conn.commit()

    cursor.execute(f'''
        CREATE TABLE IF NOT EXISTS breakdown_views (
            id         {pk},
            name       TEXT NOT NULL UNIQUE,
            category   TEXT NOT NULL,
            tag_ids    TEXT NOT NULL,
            view_mode  TEXT NOT NULL DEFAULT 'net',
            time_range TEXT NOT NULL DEFAULT '6m',
            user_id    INTEGER REFERENCES users(id)
        )
    ''')
    conn.commit()

    # Indexes
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_transaction_date ON transactions(date)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, date)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_transactions_user_applied ON transactions(user_id, applied_date)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_transactions_user_payment ON transactions(user_id, is_payment)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_payment_splits_txn ON payment_splits(transaction_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_transaction_shares_txn ON transaction_shares(transaction_id)')
    cursor.execute(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_plaid_txn_id '
        'ON transactions(plaid_transaction_id) WHERE plaid_transaction_id IS NOT NULL'
    )
    conn.commit()

    # SQLite-only column migrations (for existing databases predating current schema)
    if not USE_POSTGRES:
        import sqlite3 as _sqlite3
        _migrations = [
            ('users',         'display_name',         'TEXT'),
            ('transactions',  'bank_category',        'TEXT'),
            ('transactions',  'is_payment',           'BOOLEAN DEFAULT 0'),
            ('transactions',  'is_shared',            'BOOLEAN DEFAULT 0'),
            ('transactions',  'shared_with',          'TEXT'),
            ('transactions',  'payer',                'TEXT DEFAULT "Me"'),
            ('transactions',  'reimbursement_amount', 'DECIMAL(10, 2) DEFAULT 0'),
            ('transactions',  'is_manual_category',   'BOOLEAN DEFAULT 0'),
            ('transactions',  'plaid_transaction_id', 'TEXT'),
            ('transactions',  'applied_date',         'TEXT'),
            ('categories',    'display_order',        'INTEGER DEFAULT 0'),
            ('settlements',   'expense_share_id',     'INTEGER'),
            ('settlements',   'payment_share_id',     'INTEGER'),
        ]
        for tbl, col, defn in _migrations:
            try:
                cursor.execute(f'ALTER TABLE {tbl} ADD COLUMN {col} {defn}')
                conn.commit()
            except _sqlite3.OperationalError:
                pass

    # Seed default categories if table is empty
    cursor.execute('SELECT COUNT(*) as cnt FROM categories')
    if cursor.fetchone()['cnt'] == 0:
        for i, name in enumerate(DEFAULT_CATEGORIES):
            cursor.execute(
                'INSERT INTO categories (name, display_order) VALUES (%s, %s) ON CONFLICT DO NOTHING',
                (name, i)
            )
    conn.commit()

    # Repair broken settlement links
    cursor.execute('''
        SELECT id, payment_id, expense_id
        FROM settlements
        WHERE payment_share_id IS NULL OR expense_share_id IS NULL
    ''')
    orphans = cursor.fetchall()
    for row in orphans:
        sid, pid, eid = row['id'], row['payment_id'], row['expense_id']
        cursor.execute('SELECT id FROM transaction_shares WHERE transaction_id = %s LIMIT 1', (pid,))
        p_share = cursor.fetchone()
        cursor.execute('SELECT id FROM transaction_shares WHERE transaction_id = %s LIMIT 1', (eid,))
        e_share = cursor.fetchone()
        if p_share and e_share:
            cursor.execute(
                'UPDATE settlements SET payment_share_id = %s, expense_share_id = %s WHERE id = %s',
                (p_share['id'], e_share['id'], sid)
            )

    # Remove orphaned settlements
    cursor.execute('''
        DELETE FROM settlements
        WHERE payment_share_id NOT IN (SELECT id FROM transaction_shares)
           OR expense_share_id NOT IN (SELECT id FROM transaction_shares)
           OR payment_id NOT IN (SELECT id FROM transactions)
           OR expense_id NOT IN (SELECT id FROM transactions)
    ''')

    # User isolation: backfill user_id = 1 for any rows that predate multi-user support
    if not USE_POSTGRES:
        import sqlite3 as _sqlite3
        for _tbl in ['transactions', 'categories', 'transaction_shares',
                     'tags', 'tag_defaults', 'plaid_accounts', 'breakdown_views']:
            try:
                cursor.execute(f'ALTER TABLE {_tbl} ADD COLUMN user_id INTEGER REFERENCES users(id)')
                conn.commit()
            except _sqlite3.OperationalError:
                pass
            cursor.execute(f'UPDATE {_tbl} SET user_id = 1 WHERE user_id IS NULL')
    else:
        row = cursor.execute('SELECT COUNT(*) as cnt FROM users').fetchone()
        if row and row['cnt'] > 0:
            for _tbl in ['transactions', 'categories', 'transaction_shares',
                         'tags', 'tag_defaults', 'plaid_accounts', 'breakdown_views']:
                cursor.execute(f'UPDATE {_tbl} SET user_id = 1 WHERE user_id IS NULL')

    conn.commit()
    conn.close()

    clean_account_names()


def insert_transactions(transactions, user_id=1):
    """
    Inserts a list of tuples into the transactions table.
    Each tuple: (date, description, amount, bank_category, bank_category, merchant, card_name, is_payment)
    Skips rows that conflict on any unique constraint.
    Returns the number of rows actually inserted.
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    inserted = 0
    for t in transactions:
        cursor.execute('''
            INSERT INTO transactions
                (date, description, amount, category, bank_category, merchant, card_name, is_payment, user_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT DO NOTHING
        ''', t + (user_id,))
        inserted += max(0, cursor.rowcount)
    conn.commit()
    conn.close()
    return inserted


def get_monthly_summary():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT
            SUBSTR(CAST(date AS TEXT),1, 7) as month,
            COUNT(*) as transaction_count,
            SUM(amount) as total_spent,
            AVG(amount) as avg_transaction
        FROM transactions
        GROUP BY SUBSTR(CAST(date AS TEXT),1, 7)
        ORDER BY month DESC
    ''')
    results = cursor.fetchall()
    conn.close()
    return [dict(row) for row in results]


def get_category_breakdown(start_date=None, end_date=None):
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
        query += ' WHERE date BETWEEN %s AND %s'
        params = [start_date, end_date]
    query += ' GROUP BY category ORDER BY total_spent DESC'
    cursor.execute(query, params)
    results = cursor.fetchall()
    conn.close()
    return [dict(row) for row in results]


def get_all_transactions(limit=100):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, date, description, amount, category, bank_category,
               merchant, card_name, is_payment, is_shared, payer, reimbursement_amount,
               (SELECT COUNT(*) FROM settlements s
                WHERE s.payment_id = transactions.id OR s.expense_id = transactions.id) as settlement_count
        FROM transactions
        ORDER BY date DESC
        LIMIT %s
    ''', (limit,))
    results = cursor.fetchall()
    conn.close()
    return [dict(row) for row in results]


def get_detailed_summary(year, month=None):
    conn = get_db_connection()
    cursor = conn.cursor()

    year_query = '''
        SELECT category, SUM(amount) as total, AVG(amount) as average
        FROM transactions
        WHERE SUBSTR(CAST(date AS TEXT),1, 4) = %s
        GROUP BY category
    '''
    month_query = '''
        SELECT category, SUM(amount) as total
        FROM transactions
        WHERE SUBSTR(CAST(date AS TEXT),1, 4) = %s AND SUBSTR(CAST(date AS TEXT),6, 2) = %s
        GROUP BY category
    '''

    cursor.execute(year_query, (str(year),))
    year_data = {row['category']: dict(row) for row in cursor.fetchall()}

    month_data = {}
    if month:
        cursor.execute(month_query, (str(year), str(month).zfill(2)))
        month_data = {row['category']: dict(row) for row in cursor.fetchall()}

    conn.close()
    return {'year': year_data, 'month': month_data}


def get_detailed_breakdown(year, month, user_id=1):
    conn = get_db_connection()
    cursor = conn.cursor()

    def fetch_data(yr, mo=None):
        sql = '''
            SELECT category,
                   SUM(CASE
                        WHEN payer = 'Me' THEN amount
                        ELSE 0
                   END) as gross,
                   SUM(CASE
                        WHEN payer = 'Me' THEN (amount - COALESCE(reimbursement_amount, 0))
                        ELSE COALESCE(reimbursement_amount, 0)
                   END) as net
            FROM transactions
            WHERE SUBSTR(COALESCE(applied_date, CAST(date AS TEXT)), 1, 4) = %s AND is_payment = 0 AND user_id = %s
        '''
        params = [yr, user_id]
        if mo:
            sql += ' AND SUBSTR(COALESCE(applied_date, CAST(date AS TEXT)), 6, 2) = %s'
            params.append(mo)
        sql += ' GROUP BY category'
        cursor.execute(sql, params)
        return {row['category']: {'gross': row['gross'] or 0, 'net': row['net'] or 0}
                for row in cursor.fetchall()}

    month_totals = fetch_data(year, month)
    year_totals  = fetch_data(year)

    cursor.execute(
        'SELECT COUNT(DISTINCT SUBSTR(COALESCE(applied_date, CAST(date AS TEXT)), 1, 7)) as cnt '
        'FROM transactions '
        'WHERE SUBSTR(COALESCE(applied_date, CAST(date AS TEXT)), 1, 4) = %s AND is_payment = 0 AND user_id = %s',
        (year, user_id)
    )
    months_in_year = cursor.fetchone()['cnt'] or 1

    cursor.execute('''
        SELECT category,
               SUM(CASE
                    WHEN payer = 'Me' THEN amount
                    ELSE 0
               END) / %s as gross_avg,
               SUM(CASE
                    WHEN payer = 'Me' THEN (amount - COALESCE(reimbursement_amount, 0))
                    ELSE COALESCE(reimbursement_amount, 0)
               END) / %s as net_avg
        FROM transactions
        WHERE SUBSTR(COALESCE(applied_date, CAST(date AS TEXT)), 1, 4) = %s AND is_payment = 0 AND user_id = %s
        GROUP BY category
    ''', (months_in_year, months_in_year, year, user_id))
    year_averages = {row['category']: {'gross': row['gross_avg'] or 0, 'net': row['net_avg'] or 0}
                     for row in cursor.fetchall()}

    conn.close()
    return {
        'month_totals': month_totals,
        'year_totals': year_totals,
        'year_averages': year_averages,
    }


def get_overview_history(year, month, view_mode='gross', time_range='1y', user_id=1):
    from dateutil.relativedelta import relativedelta
    from calendar import monthrange
    from collections import defaultdict

    conn = get_db_connection()
    cursor = conn.cursor()

    if view_mode == 'gross':
        amount_sql_case = "CASE WHEN payer = 'Me' THEN amount ELSE 0 END"
    else:
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
    else:
        start_date = end_date - relativedelta(months=11)

    start_str = start_date.strftime('%Y-%m-01')
    last_day  = monthrange(int(year), int(month))[1]
    end_str   = f'{year}-{int(month):02d}-{last_day}'

    categories = get_categories(user_id)
    category_placeholders = ','.join(['%s'] * len(categories))

    cursor.execute(f'''
        SELECT SUBSTR(COALESCE(applied_date, CAST(date AS TEXT)), 1, 7) as month_key,
               category,
               SUM({amount_sql_case}) as total
        FROM transactions
        WHERE COALESCE(applied_date, CAST(date AS TEXT)) >= %s
          AND COALESCE(applied_date, CAST(date AS TEXT)) <= %s
          AND is_payment = 0 AND user_id = %s AND category IN ({category_placeholders})
        GROUP BY month_key, category
    ''', (start_str, end_str, user_id, *categories))

    month_cat = defaultdict(lambda: defaultdict(float))
    for row in cursor.fetchall():
        month_cat[row['month_key']][row['category']] = float(row['total'] or 0)

    conn.close()

    months = []
    series = {cat: [] for cat in categories}
    current_date = start_date
    while current_date <= end_date:
        month_key = current_date.strftime('%Y-%m')
        months.append(current_date.strftime('%b %Y'))
        for cat in categories:
            series[cat].append(month_cat[month_key].get(cat, 0))
        current_date += relativedelta(months=1)

    return {'months': months, 'categories': series}


def clean_account_names():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE transactions SET card_name = 'Chase' WHERE card_name LIKE %s", ('%Chase%',))
    cursor.execute("UPDATE transactions SET card_name = 'Capital One' WHERE card_name LIKE %s", ('%Simply%',))
    cursor.execute("UPDATE transactions SET card_name = 'Venmo' WHERE card_name LIKE %s", ('%Venmo%',))
    conn.commit()
    conn.close()


def migrate_to_unique():
    """One-time local SQLite migration to add a unique constraint. Not used in production."""
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute('DROP TABLE IF EXISTS transactions_old')
        cursor.execute('ALTER TABLE transactions RENAME TO transactions_old')
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
        cursor.execute('''
            INSERT INTO transactions
            (id, date, description, amount, category, bank_category, merchant, card_name,
             is_payment, is_shared, shared_with, payer, reimbursement_amount,
             is_manual_category, created_at)
            SELECT
            id, date, description, amount, category, bank_category, merchant, card_name,
            is_payment, is_shared, shared_with, payer, reimbursement_amount,
            is_manual_category, created_at
            FROM transactions_old
            ON CONFLICT DO NOTHING
        ''')
        cursor.execute('DROP TABLE transactions_old')
        conn.commit()
        print("Deduplication migration successful!")
    except Exception as e:
        conn.rollback()
        print(f"Migration failed: {e}")
        try:
            cursor.execute('ALTER TABLE transactions_old RENAME TO transactions')
            conn.commit()
        except Exception:
            pass
    finally:
        conn.close()
