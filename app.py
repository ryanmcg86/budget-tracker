from flask import Flask, render_template, request, jsonify
from flask_login import login_required, current_user
from flask.json.provider import DefaultJSONProvider
import pandas as pd
import os
import datetime as _dt
from datetime import datetime
from decimal import Decimal as _Decimal
from dotenv import load_dotenv
from database import init_db, insert_transactions, get_monthly_summary
from auth import auth_bp, login_manager

load_dotenv()

class _ISODateProvider(DefaultJSONProvider):
    @staticmethod
    def default(o):
        if isinstance(o, (_dt.date, _dt.datetime)):
            return o.isoformat()
        if isinstance(o, _Decimal):
            return float(o)
        return DefaultJSONProvider.default(o)

app = Flask(__name__)
app.json_provider_class = _ISODateProvider
app.json = _ISODateProvider(app)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', os.urandom(24))

login_manager.init_app(app)
app.register_blueprint(auth_bp)

# Ensure upload folder exists
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Initialize database
init_db()

@app.before_request
def require_login():
    from flask_login import current_user
    from flask import request as req
    # Allow login/logout and static files through without auth
    if req.endpoint and (req.endpoint.startswith('auth.') or req.endpoint == 'static'):
        return
    if not current_user.is_authenticated:
        from flask import redirect, url_for
        return redirect(url_for('auth.login'))

@app.route('/')
def index():
    from database import get_categories
    return render_template('index.html', tracked_categories=get_categories())

@app.route('/upload', methods=['POST'])
def upload_csv():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part in the request'}), 400

    file = request.files['file']
    bank_name = request.form.get('bank_name', 'Unknown')

    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    if file and file.filename.lower().endswith('.csv'):
        try:
            try:
                df = pd.read_csv(file, encoding='utf-8')
            except UnicodeDecodeError:
                file.seek(0)
                df = pd.read_csv(file, encoding='latin1')

            count = process_csv(df, card_name=bank_name, user_id=current_user.id)

            return jsonify({
                'success': True,
                'message': f'Uploaded {count} transactions to {bank_name} successfully'
            })

        except Exception as e:
            print(f"Upload Error: {e}")
            return jsonify({'error': f'Failed to process CSV: {str(e)}'}), 500

    return jsonify({'error': 'File must be a .csv file'}), 400


@app.route('/api/summary')
def get_summary():
    summary = get_monthly_summary()
    return jsonify(summary)

def process_csv(df, card_name="Unknown", user_id=1):
    df.columns = [c.strip().lower() for c in df.columns]
    headers = df.columns

    date_col = next((h for h in headers if 'date' in h), None)
    desc_col = next((h for h in headers if 'description' in h or 'memo' in h or 'name' in h), None)
    amt_col  = next((h for h in headers if 'amount' in h or 'charge' in h or 'value' in h), None)

    cat_options = ['category', 'transaction type', 'type', 'group', 'class', 'memo']
    cat_col = next((h for h in headers if any(opt in h for opt in cat_options)), None)

    if not all([date_col, desc_col, amt_col]):
        print(f"Missing core columns in {card_name}. Headers found: {list(headers)}")
        return 0

    final_data = []
    seen_in_batch = {}

    for _, row in df.iterrows():
        try:
            if pd.isna(row[date_col]) or pd.isna(row[amt_col]):
                continue

            description = str(row[desc_col]).strip()
            raw_amt = float(str(row[amt_col]).replace('$', '').replace(',', '').replace('(', '-').replace(')', ''))

            bank_cat = str(row[cat_col]) if cat_col and pd.notna(row[cat_col]) else 'Uncategorized'

            txn_type_val = bank_cat.lower()
            is_payment = 0
            if any(word in txn_type_val for word in ['payment', 'credit', 'return']):
                is_payment = 1
            elif any(word in description.lower() for word in ['payment', 'thank you', 'tfr-out', 'credit']):
                is_payment = 1

            if is_payment == 0:
                clean_amount = abs(raw_amt)
            else:
                clean_amount = raw_amt

            clean_date = pd.to_datetime(row[date_col]).strftime('%Y-%m-%d')

            key = (clean_date, description, clean_amount, card_name)
            occurrence = seen_in_batch.get(key, 0) + 1
            seen_in_batch[key] = occurrence

            db_description = f"{description} ({occurrence})" if occurrence > 1 else description

            final_data.append((
                clean_date,
                db_description,
                clean_amount,
                bank_cat,
                bank_cat,
                db_description,
                card_name,
                int(is_payment)
            ))
        except Exception as e:
            print(f"Error on row: {e}")
            continue

    if final_data:
        from database import insert_transactions
        count = insert_transactions(final_data, user_id)
        return count
    return 0


@app.route('/api/transaction/<int:txn_id>/toggle-shared', methods=['POST'])
def toggle_shared(txn_id):
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('UPDATE transactions SET is_shared = 1 - is_shared WHERE id = %s AND user_id = %s',
                   (txn_id, current_user.id))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/transaction/<int:txn_id>', methods=['DELETE'])
def delete_transaction(txn_id):
    try:
        from database import get_db_connection
        conn = get_db_connection()
        cursor = conn.cursor()

        cursor.execute('DELETE FROM settlements WHERE payment_id = %s OR expense_id = %s', (txn_id, txn_id))
        cursor.execute('DELETE FROM transaction_shares WHERE transaction_id = %s', (txn_id,))
        cursor.execute('DELETE FROM transaction_tags WHERE transaction_id = %s', (txn_id,))
        cursor.execute('DELETE FROM transactions WHERE id = %s AND user_id = %s', (txn_id, current_user.id))
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'message': 'Transaction deleted'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/rules', methods=['GET', 'POST'])
def manage_rules():
    from database import add_rule, get_all_rules, apply_rules_to_all
    if request.method == 'POST':
        data = request.json
        add_rule(data['keyword'], data['category'], data.get('amount'))
        apply_rules_to_all()
        return jsonify({'success': True})

    return jsonify(get_all_rules())

@app.route('/api/rules/<int:rule_id>', methods=['DELETE'])
def delete_rule(rule_id):
    try:
        from database import get_db_connection
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM category_rules WHERE id = %s', (rule_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/detailed-summary')
def detailed_summary():
    year = request.args.get('year')
    month = request.args.get('month')

    from database import get_detailed_breakdown
    data = get_detailed_breakdown(year, month, current_user.id)
    return jsonify(data)

@app.route('/api/overview-history')
def overview_history():
    year = request.args.get('year')
    month = request.args.get('month')
    view_mode = request.args.get('view_mode', 'gross')
    time_range = request.args.get('time_range', '1y')

    from database import get_overview_history
    data = get_overview_history(year, month, view_mode, time_range, current_user.id)
    return jsonify(data)


@app.route('/api/account-breakdown')
@login_required
def account_breakdown():
    year = request.args.get('year')
    month = request.args.get('month')
    view_mode = request.args.get('view_mode', 'gross')

    if view_mode == 'gross':
        amount_case = "CASE WHEN payer = 'Me' THEN amount ELSE 0 END"
    else:
        amount_case = "CASE WHEN payer = 'Me' THEN (amount - COALESCE(reimbursement_amount, 0)) ELSE COALESCE(reimbursement_amount, 0) END"

    from database import get_db_connection
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(f'''
        SELECT card_name, SUM({amount_case}) as total
        FROM transactions
        WHERE user_id = %s AND is_payment = 0
          AND SUBSTR(COALESCE(applied_date, CAST(date AS TEXT)), 1, 4) = %s
          AND SUBSTR(COALESCE(applied_date, CAST(date AS TEXT)), 6, 2) = %s
        GROUP BY card_name
        ORDER BY total DESC
    ''', (current_user.id, year, month))
    rows = [{'name': r['card_name'] or 'Unknown', 'total': round(r['total'] or 0, 2)} for r in cur.fetchall()]
    conn.close()
    return jsonify({'accounts': rows})


@app.route('/api/sankey-data')
def sankey_data():
    from database import get_db_connection, get_categories
    TRACKED_CATEGORIES = get_categories(current_user.id)
    from dateutil.relativedelta import relativedelta
    from calendar import monthrange

    year  = int(request.args.get('year'))
    month = int(request.args.get('month'))
    view_mode  = request.args.get('view_mode', 'gross')
    time_range = request.args.get('time_range', '6m')

    end_dt = datetime(year, month, 1)
    if time_range == '1m':
        start_dt = end_dt
    elif time_range == '3m':
        start_dt = end_dt - relativedelta(months=2)
    elif time_range == '6m':
        start_dt = end_dt - relativedelta(months=5)
    elif time_range == '5y':
        start_dt = end_dt - relativedelta(years=4, months=11)
    else:
        start_dt = end_dt - relativedelta(months=11)

    start_str = start_dt.strftime('%Y-%m-01')
    last_day  = monthrange(year, month)[1]
    end_str   = f'{year}-{month:02d}-{last_day}'

    conn = get_db_connection()
    cur  = conn.cursor()

    shared_filter = 'AND is_shared = 0' if view_mode == 'net' else ''

    cur.execute(f'''
        SELECT COALESCE(SUM(ABS(amount)), 0) as total
        FROM transactions t
        WHERE t.is_payment = 1 AND t.user_id = %s {shared_filter}
          AND NOT EXISTS (SELECT 1 FROM payment_splits WHERE transaction_id = t.id)
          AND COALESCE(t.applied_date, CAST(t.date AS TEXT)) >= %s AND COALESCE(t.applied_date, CAST(t.date AS TEXT)) <= %s
    ''', (current_user.id, start_str, end_str))
    income = cur.fetchone()['total']

    cur.execute(f'''
        SELECT COALESCE(SUM(ps.amount), 0) as total
        FROM payment_splits ps
        JOIN transactions t ON ps.transaction_id = t.id
        WHERE t.is_payment = 1 AND t.user_id = %s {shared_filter}
          AND ps.applied_date >= %s AND ps.applied_date <= %s
    ''', (current_user.id, start_str, end_str))
    income += cur.fetchone()['total']

    if view_mode == 'gross':
        amount_case = '''
            CASE WHEN payer = 'Me' THEN amount ELSE 0 END
        '''
    else:
        amount_case = '''
            CASE WHEN payer = 'Me' THEN (amount - COALESCE(reimbursement_amount, 0))
                 ELSE COALESCE(reimbursement_amount, 0) END
        '''
    placeholders = ','.join(['%s'] * len(TRACKED_CATEGORIES))
    cur.execute(f'''
        SELECT category, SUM({amount_case}) as total
        FROM transactions
        WHERE is_payment = 0 AND user_id = %s
          AND COALESCE(applied_date, CAST(date AS TEXT)) >= %s AND COALESCE(applied_date, CAST(date AS TEXT)) <= %s
          AND category IN ({placeholders})
        GROUP BY category
        HAVING SUM({amount_case}) > 0
        ORDER BY total DESC
    ''', (current_user.id, start_str, end_str, *TRACKED_CATEGORIES))
    categories = [{'name': r['category'], 'total': round(r['total'], 2)} for r in cur.fetchall()]

    cur.execute(f'''
        SELECT COALESCE(SUM({amount_case}), 0) as total
        FROM transactions
        WHERE is_payment = 0 AND user_id = %s
          AND COALESCE(applied_date, CAST(date AS TEXT)) >= %s AND COALESCE(applied_date, CAST(date AS TEXT)) <= %s
          AND (category IS NULL OR category = '' OR category NOT IN ({placeholders}))
    ''', (current_user.id, start_str, end_str, *TRACKED_CATEGORIES))
    uncategorized = round(cur.fetchone()['total'], 2)
    if uncategorized > 0.01:
        categories.append({'name': 'Uncategorized', 'total': uncategorized})

    cur.execute('''
        SELECT COUNT(DISTINCT SUBSTR(COALESCE(applied_date, CAST(date AS TEXT)), 1, 7)) as cnt
        FROM transactions
        WHERE user_id = %s AND COALESCE(applied_date, CAST(date AS TEXT)) >= %s AND COALESCE(applied_date, CAST(date AS TEXT)) <= %s
    ''', (current_user.id, start_str, end_str))
    months_in_range = max(1, cur.fetchone()['cnt'])

    conn.close()

    return jsonify({
        'income': round(income, 2),
        'categories': categories,
        'months_in_range': months_in_range,
    })


@app.route('/api/transaction/<int:txn_id>/toggle-payment', methods=['POST'])
def toggle_payment(txn_id):
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('UPDATE transactions SET is_payment = 1 - is_payment WHERE id = %s AND user_id = %s',
                   (txn_id, current_user.id))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/transaction/manual', methods=['POST'])
def add_manual_transaction():
    try:
        data = request.json
        from database import get_db_connection
        conn = get_db_connection()
        cursor = conn.cursor()

        is_pay   = data.get('is_payment', 0)
        is_shared = data.get('is_shared', 0)
        payer    = data.get('payer', 'Me')
        shares   = data.get('shares', [])

        cursor.execute('''
            INSERT INTO transactions
            (date, description, amount, category, bank_category, card_name, is_payment, is_shared, payer, is_manual_category, user_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 1, %s)
        ''', (
            data['date'],
            data['description'],
            data['amount'],
            data['category'],
            data['category'],
            data['account'],
            is_pay,
            is_shared,
            payer,
            current_user.id
        ))
        txn_id = cursor.lastrowid

        if is_shared == 1:
            total_reimb = 0
            for share in shares:
                amt = float(share.get('amount', 0))
                total_reimb += amt
                cursor.execute(
                    'INSERT INTO transaction_shares (transaction_id, person_name, share_amount) VALUES (%s, %s, %s)',
                    (txn_id, share.get('name'), amt)
                )
            cursor.execute('UPDATE transactions SET reimbursement_amount = %s WHERE id = %s',
                           (total_reimb, txn_id))

        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        print(f"Manual Entry Error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/transaction/bulk-edit', methods=['POST'])
def bulk_edit_transactions():
    try:
        data = request.json
        ids = data.get('ids', [])
        new_desc = data.get('description')
        new_cat = data.get('category')
        applied_date_raw = data.get('applied_date')

        is_shared = data.get('is_shared')
        payer = data.get('payer')
        shares = data.get('shares', [])

        from database import get_db_connection
        conn = get_db_connection()
        cursor = conn.cursor()

        for txn_id in ids:
            if new_desc:
                cursor.execute('''
                    UPDATE transactions
                    SET description = %s, merchant = %s
                    WHERE id = %s AND user_id = %s
                ''', (new_desc, new_desc, txn_id, current_user.id))

            if new_cat:
                cursor.execute('''
                    UPDATE transactions
                    SET category = %s, is_manual_category = 1
                    WHERE id = %s AND user_id = %s
                ''', (new_cat, txn_id, current_user.id))

            if 'applied_date' in data:
                cursor.execute('UPDATE transactions SET applied_date = %s WHERE id = %s AND user_id = %s',
                               (applied_date_raw or None, txn_id, current_user.id))

            if 'payment_splits' in data:
                cursor.execute('DELETE FROM payment_splits WHERE transaction_id = %s', (txn_id,))
                for split in data['payment_splits']:
                    if split.get('date') and float(split.get('amount', 0)) > 0:
                        cursor.execute(
                            'INSERT INTO payment_splits (transaction_id, amount, applied_date, note) VALUES (%s, %s, %s, %s)',
                            (txn_id, float(split['amount']), split['date'], split.get('note') or None)
                        )

            if is_shared is not None:
                cursor.execute('SELECT id, person_name FROM transaction_shares WHERE transaction_id = %s', (txn_id,))
                old_shares = {row['person_name']: row['id'] for row in cursor.fetchall()}

                cursor.execute('''
                    UPDATE transactions
                    SET is_shared = %s, payer = %s
                    WHERE id = %s AND user_id = %s
                ''', (is_shared, payer or 'Me', txn_id, current_user.id))

                cursor.execute('DELETE FROM transaction_shares WHERE transaction_id = %s', (txn_id,))

                if is_shared == 1:
                    total_reimbursement = 0
                    for share in shares:
                        name = share.get('name')
                        amt  = float(share.get('amount', 0))
                        total_reimbursement += amt

                        cursor.execute('''
                            INSERT INTO transaction_shares (transaction_id, person_name, share_amount)
                            VALUES (%s, %s, %s)
                        ''', (txn_id, name, amt))
                        new_share_id = cursor.lastrowid

                        if name in old_shares:
                            old_sid = old_shares[name]
                            cursor.execute('UPDATE settlements SET payment_share_id = %s WHERE payment_share_id = %s',
                                           (new_share_id, old_sid))
                            cursor.execute('UPDATE settlements SET expense_share_id = %s WHERE expense_share_id = %s',
                                           (new_share_id, old_sid))

                    cursor.execute('UPDATE transactions SET reimbursement_amount = %s WHERE id = %s AND user_id = %s',
                                   (total_reimbursement, txn_id, current_user.id))
                else:
                    cursor.execute('UPDATE transactions SET reimbursement_amount = 0 WHERE id = %s AND user_id = %s',
                                   (txn_id, current_user.id))

        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        print(f"Bulk Edit Error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/shared-ledger')
def shared_ledger():
    person_filter = request.args.get('person', '')
    year_filter   = request.args.get('year', '')
    month_filter  = request.args.get('month', '')
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute('''
        SELECT DISTINCT name FROM (
            SELECT ts.person_name as name FROM transaction_shares ts
            JOIN transactions t ON ts.transaction_id = t.id WHERE t.user_id = %s
            UNION
            SELECT payer as name FROM transactions WHERE user_id = %s
        ) q WHERE name != 'Me' AND name IS NOT NULL AND name != '' ORDER BY name
    ''', (current_user.id, current_user.id))
    all_people_names = [row['name'] for row in cursor.fetchall()]

    people_with_balances = []
    for person_name in all_people_names:
        balance_sql = '''
            SELECT SUM(CASE WHEN t.payer = 'Me' THEN ts.share_amount ELSE -ts.share_amount END) as balance
            FROM transactions t
            JOIN transaction_shares ts ON t.id = ts.transaction_id
            WHERE t.is_shared = 1 AND t.user_id = %s AND (
                (t.payer = 'Me' AND ts.person_name = %s) OR
                (t.payer = %s AND ts.person_name = 'Me')
            )
        '''
        cursor.execute(balance_sql, (current_user.id, person_name, person_name))
        result = cursor.fetchone()
        balance = result['balance'] if result and result['balance'] is not None else 0
        people_with_balances.append({'name': person_name, 'balance': balance})

    people_data = {
        "owes_me": sorted([p for p in people_with_balances if p['balance'] > 0.01], key=lambda x: x['balance'], reverse=True),
        "i_owe":   sorted([p for p in people_with_balances if p['balance'] < -0.01], key=lambda x: x['balance']),
        "settled": sorted([p for p in people_with_balances if -0.01 <= p['balance'] <= 0.01], key=lambda x: x['name'])
    }

    ledger = []
    net_balance = 0

    sql = '''
        SELECT t.id, t.date, t.applied_date, t.description, t.payer,
               ts.share_amount, t.is_payment, ts.person_name
        FROM transactions t
        JOIN transaction_shares ts ON t.id = ts.transaction_id
        WHERE t.is_shared = 1 AND t.user_id = %s AND (
            (t.payer = 'Me' AND ts.person_name != 'Me' {filter_clause_payer}) OR
            (t.payer != 'Me' AND ts.person_name = 'Me' {filter_clause_share})
        )
        ORDER BY t.date ASC
    '''

    filter_payer = "AND ts.person_name = %s" if person_filter else ""
    filter_share = "AND t.payer = %s" if person_filter else ""

    query = sql.format(filter_clause_payer=filter_payer, filter_clause_share=filter_share)
    if person_filter:
        params = (current_user.id, person_filter, person_filter)
    else:
        params = (current_user.id,)

    cursor.execute(query, params)
    rows = cursor.fetchall()

    txn_ids = list({row['id'] for row in rows})
    tags_by_txn = {}
    if txn_ids:
        placeholders_t = ','.join(['%s'] * len(txn_ids))
        cursor.execute(f'''
            SELECT tt.transaction_id, tags.id, tags.name
            FROM tags JOIN transaction_tags tt ON tags.id = tt.tag_id
            WHERE tt.transaction_id IN ({placeholders_t})
            ORDER BY tags.name
        ''', txn_ids)
        for tr in cursor.fetchall():
            tags_by_txn.setdefault(tr['transaction_id'], []).append({'id': tr['id'], 'name': tr['name']})

    payment_ids = [row['id'] for row in rows if row['is_payment']]
    splits_by_txn = {}
    if payment_ids:
        placeholders_p = ','.join(['%s'] * len(payment_ids))
        cursor.execute(f'''
            SELECT transaction_id, amount, applied_date, note
            FROM payment_splits
            WHERE transaction_id IN ({placeholders_p})
            ORDER BY applied_date
        ''', payment_ids)
        for sp in cursor.fetchall():
            splits_by_txn.setdefault(sp['transaction_id'], []).append(dict(sp))

    expanded = []
    for row in rows:
        base = dict(row)
        base['tags'] = tags_by_txn.get(base['id'], [])

        if base['is_payment'] and base['id'] in splits_by_txn:
            for sp in splits_by_txn[base['id']]:
                split_row = dict(base)
                split_row['date'] = sp['applied_date']
                split_row['share_amount'] = sp['amount']
                split_row['is_split'] = True
                split_row['split_note'] = sp.get('note') or ''
                expanded.append(split_row)
        else:
            base['date'] = base.get('applied_date') or base['date']
            base['is_split'] = False
            base['split_note'] = ''
            expanded.append(base)

    expanded.sort(key=lambda r: r['date'])

    running_bal = 0
    for item in expanded:
        amt = float(item['share_amount'])
        change = amt if item['payer'] == 'Me' else -amt
        running_bal += change
        item['net_change'] = change

    net_balance = running_bal

    if year_filter and month_filter:
        prefix = f"{year_filter}-{month_filter.zfill(2)}"
        display_rows = [r for r in expanded if r['date'].startswith(prefix)]
    elif year_filter:
        display_rows = [r for r in expanded if r['date'].startswith(year_filter)]
    else:
        display_rows = expanded

    month_running = 0
    for item in display_rows:
        month_running += item['net_change']
        item['running_balance'] = month_running
        ledger.append(item)

    ledger.reverse()

    conn.close()
    return jsonify({
        'people': people_data,
        'ledger': ledger,
        'net_balance': net_balance,
        'month_net': round(month_running, 2),
        'is_filtered': bool(year_filter or month_filter),
    })


@app.route('/api/account', methods=['GET'])
def api_account_get():
    from flask_login import current_user
    from database import get_db_connection
    conn = get_db_connection()
    row = conn.execute('SELECT email, display_name FROM users WHERE id = %s', (current_user.id,)).fetchone()
    conn.close()
    return jsonify({'email': row['email'], 'display_name': row['display_name'] or ''})


@app.route('/api/account/profile', methods=['PATCH'])
def api_account_profile():
    from flask_login import current_user
    from database import get_db_connection
    data = request.json or {}
    display_name = data.get('display_name', '').strip()
    email = data.get('email', '').strip().lower()
    if not email:
        return jsonify({'error': 'Email is required.'}), 400
    conn = get_db_connection()
    try:
        conn.execute('UPDATE users SET display_name = %s, email = %s WHERE id = %s',
                     (display_name or None, email, current_user.id))
        conn.commit()
    except Exception:
        conn.close()
        return jsonify({'error': 'That email is already in use.'}), 409
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/account/password', methods=['PATCH'])
def api_account_password():
    from flask_login import current_user
    from database import get_db_connection
    import bcrypt
    data = request.json or {}
    current_pw = data.get('current_password', '').encode()
    new_pw     = data.get('new_password', '').encode()
    if len(new_pw) < 8:
        return jsonify({'error': 'New password must be at least 8 characters.'}), 400
    conn = get_db_connection()
    row = conn.execute('SELECT password_hash FROM users WHERE id = %s', (current_user.id,)).fetchone()
    ph = row['password_hash']
    if isinstance(ph, str):
        ph = ph.encode('utf-8')
    if not bcrypt.checkpw(current_pw, ph):
        conn.close()
        return jsonify({'error': 'Current password is incorrect.'}), 403
    new_hash = bcrypt.hashpw(new_pw, bcrypt.gensalt()).decode('utf-8')
    conn.execute('UPDATE users SET password_hash = %s WHERE id = %s', (new_hash, current_user.id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/account/export', methods=['GET'])
def api_account_export():
    from database import get_db_connection
    import csv, io
    conn = get_db_connection()
    rows = conn.execute('''
        SELECT date, description, amount, category, card_name, payer,
               reimbursement_amount, is_payment, is_shared, applied_date
        FROM transactions
        WHERE user_id = %s
        ORDER BY COALESCE(applied_date, CAST(date AS TEXT)) DESC
    ''', (current_user.id,)).fetchall()
    conn.close()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(['Date', 'Description', 'Amount', 'Category', 'Account',
                     'Payer', 'Reimbursement', 'Is Payment', 'Is Shared', 'Applied Date'])
    for r in rows:
        writer.writerow(list(r))
    buf.seek(0)
    from flask import Response
    return Response(
        buf.getvalue(),
        mimetype='text/csv',
        headers={'Content-Disposition': 'attachment; filename=budget_export.csv'}
    )


@app.route('/api/account', methods=['DELETE'])
def api_account_delete():
    from flask_login import current_user, logout_user
    from database import get_db_connection
    data = request.json or {}
    email_confirm = data.get('email', '').strip().lower()
    conn = get_db_connection()
    row = conn.execute('SELECT email FROM users WHERE id = %s', (current_user.id,)).fetchone()
    if email_confirm != row['email']:
        conn.close()
        return jsonify({'error': 'Email does not match.'}), 403
    uid = current_user.id
    for child in ['transaction_shares', 'settlements', 'payment_splits', 'transaction_tags']:
        try:
            conn.execute(f'DELETE FROM {child} WHERE transaction_id IN (SELECT id FROM transactions WHERE user_id = %s)', (uid,))
        except Exception:
            pass
    for tbl in ['tag_defaults', 'tags', 'plaid_accounts', 'transactions', 'categories']:
        try:
            conn.execute(f'DELETE FROM {tbl} WHERE user_id = %s', (uid,))
        except Exception:
            pass
    conn.execute('DELETE FROM users WHERE id = %s', (current_user.id,))
    conn.commit()
    conn.close()
    logout_user()
    return jsonify({'ok': True})


@app.route('/api/categories', methods=['GET'])
def api_list_categories():
    from database import get_categories
    return jsonify(get_categories(current_user.id))


@app.route('/api/categories', methods=['POST'])
def api_add_category():
    from database import get_db_connection
    name = (request.json or {}).get('name', '').strip()
    if not name:
        return jsonify({'error': 'name required'}), 400
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('SELECT COALESCE(MAX(display_order), -1) + 1 as next_order FROM categories')
    next_order = cur.fetchone()['next_order']
    try:
        cur.execute('INSERT INTO categories (name, display_order, user_id) VALUES (%s, %s, %s)',
                    (name, next_order, current_user.id))
        conn.commit()
    except Exception:
        conn.close()
        return jsonify({'error': 'category already exists'}), 409
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/categories/<string:name>', methods=['PATCH'])
def api_rename_category(name):
    from database import get_db_connection
    new_name = (request.json or {}).get('name', '').strip()
    if not new_name:
        return jsonify({'error': 'name required'}), 400
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('UPDATE categories SET name = %s WHERE name = %s AND user_id = %s',
                (new_name, name, current_user.id))
    cur.execute('UPDATE transactions SET category = %s WHERE category = %s AND user_id = %s',
                (new_name, name, current_user.id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/categories/<string:name>', methods=['DELETE'])
def api_delete_category(name):
    from database import get_db_connection
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('SELECT COUNT(*) as cnt FROM transactions WHERE category = %s AND is_payment = 0 AND user_id = %s',
                (name, current_user.id))
    count = cur.fetchone()['cnt']
    if count > 0 and not request.args.get('confirm'):
        conn.close()
        return jsonify({'confirm_required': True, 'count': count}), 409
    cur.execute('DELETE FROM categories WHERE name = %s AND user_id = %s', (name, current_user.id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/categories/reorder', methods=['POST'])
def api_reorder_categories():
    from database import get_db_connection
    ordered = (request.json or {}).get('order', [])
    conn = get_db_connection()
    cur = conn.cursor()
    for i, name in enumerate(ordered):
        cur.execute('UPDATE categories SET display_order = %s WHERE name = %s AND user_id = %s',
                    (i, name, current_user.id))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/people')
def get_people():
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('''
        SELECT DISTINCT name FROM (
            SELECT ts.person_name as name FROM transaction_shares ts
            JOIN transactions t ON ts.transaction_id = t.id WHERE t.user_id = %s
            UNION
            SELECT payer as name FROM transactions WHERE user_id = %s
        ) q WHERE name IS NOT NULL AND name != '' ORDER BY name
    ''', (current_user.id, current_user.id))
    people = [row['name'] for row in cursor.fetchall()]
    conn.close()
    return jsonify(people)

@app.route('/api/transaction/<int:txn_id>/details')
def get_transaction_details(txn_id):
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute('SELECT * FROM transactions WHERE id = %s AND user_id = %s', (txn_id, current_user.id))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Transaction not found'}), 404
    txn = dict(row)

    cursor.execute('SELECT COUNT(*) as cnt FROM settlements WHERE payment_id = %s OR expense_id = %s',
                   (txn_id, txn_id))
    txn['settlement_count'] = cursor.fetchone()['cnt']

    cursor.execute('SELECT person_name, share_amount FROM transaction_shares WHERE transaction_id = %s', (txn_id,))
    shares = [dict(row) for row in cursor.fetchall()]

    cursor.execute('SELECT id, amount, applied_date, note FROM payment_splits WHERE transaction_id = %s ORDER BY applied_date',
                   (txn_id,))
    payment_splits = [dict(row) for row in cursor.fetchall()]

    conn.close()
    return jsonify({**txn, 'shares': shares, 'payment_splits': payment_splits})

@app.route('/api/tags', methods=['GET', 'POST'])
def manage_tags():
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()

    if request.method == 'POST':
        data = request.json
        ids = data.get('ids', [])
        tag_name = data.get('tag_name', '').strip()
        if not tag_name: return jsonify({'error': 'Tag name required'}), 400

        cursor.execute('INSERT INTO tags (name, user_id) VALUES (%s, %s) ON CONFLICT DO NOTHING',
                       (tag_name, current_user.id))
        cursor.execute('SELECT id FROM tags WHERE name = %s AND user_id = %s', (tag_name, current_user.id))
        tag_id = cursor.fetchone()['id']

        for txn_id in ids:
            cursor.execute(
                'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (%s, %s) ON CONFLICT DO NOTHING',
                (txn_id, tag_id)
            )

        conn.commit()
        conn.close()
        return jsonify({'success': True})

    category = request.args.get('category', '').strip()
    if category:
        cursor.execute('''
            SELECT DISTINCT t.id, t.name
            FROM tags t
            JOIN transaction_tags tt ON tt.tag_id = t.id
            JOIN transactions tx ON tx.id = tt.transaction_id
            WHERE t.user_id = %s AND tx.user_id = %s AND tx.category = %s
            ORDER BY t.name
        ''', (current_user.id, current_user.id, category))
    else:
        cursor.execute('SELECT * FROM tags WHERE user_id = %s ORDER BY name', (current_user.id,))
    tags = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify(tags)

@app.route('/api/tag/<int:tag_id>', methods=['DELETE'])
def delete_tag(tag_id):
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute('DELETE FROM transaction_tags WHERE tag_id = %s', (tag_id,))
        cursor.execute('DELETE FROM tag_defaults WHERE tag_id = %s', (tag_id,))
        cursor.execute('DELETE FROM tags WHERE id = %s AND user_id = %s', (tag_id, current_user.id))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        conn.rollback()
        conn.close()
        return jsonify({'error': str(e)}), 500

@app.route('/api/tag-defaults', methods=['GET', 'POST'])
def tag_defaults():
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()

    if request.method == 'POST':
        data = request.json
        category = data.get('category')
        tag_ids = data.get('tag_ids', [])
        cursor.execute('DELETE FROM tag_defaults WHERE category = %s AND user_id = %s',
                       (category, current_user.id))
        for tid in tag_ids:
            cursor.execute('INSERT INTO tag_defaults (category, tag_id, user_id) VALUES (%s, %s, %s)',
                           (category, tid, current_user.id))
        conn.commit()
        conn.close()
        return jsonify({'success': True})

    category = request.args.get('category')
    cursor.execute('SELECT tag_id FROM tag_defaults WHERE category = %s AND user_id = %s',
                   (category, current_user.id))
    defaults = [row['tag_id'] for row in cursor.fetchall()]
    conn.close()
    return jsonify(defaults)

@app.route('/api/breakdown-views', methods=['GET', 'POST'])
def breakdown_views():
    from database import get_db_connection
    conn = get_db_connection()
    cur = conn.cursor()

    if request.method == 'POST':
        data = request.json
        try:
            cur.execute('''
                INSERT INTO breakdown_views (name, category, tag_ids, view_mode, time_range, user_id)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT(name) DO UPDATE SET
                    category=excluded.category,
                    tag_ids=excluded.tag_ids,
                    view_mode=excluded.view_mode,
                    time_range=excluded.time_range
            ''', (
                data['name'], data['category'],
                data['tag_ids'],
                data.get('view_mode', 'net'),
                data.get('time_range', '6m'),
                current_user.id,
            ))
            conn.commit()
            conn.close()
            return jsonify({'success': True})
        except Exception as e:
            conn.close()
            return jsonify({'error': str(e)}), 500

    cur.execute('SELECT * FROM breakdown_views WHERE user_id = %s ORDER BY name', (current_user.id,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify(rows)


@app.route('/api/breakdown-views/<int:view_id>', methods=['DELETE'])
def delete_breakdown_view(view_id):
    from database import get_db_connection
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('DELETE FROM breakdown_views WHERE id = %s AND user_id = %s', (view_id, current_user.id))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/breakdown-report')
def breakdown_report():
    year = request.args.get('year')
    month = request.args.get('month')
    category = request.args.get('category')
    tag_ids = request.args.getlist('tag_ids', type=int)
    view_mode = request.args.get('view_mode', 'gross')
    time_range = request.args.get('time_range', '1y')

    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()

    from dateutil.relativedelta import relativedelta

    end_date = datetime(int(year), int(month), 1)
    if time_range == '3m':
        start_date = end_date - relativedelta(months=2)
    elif time_range == '6m':
        start_date = end_date - relativedelta(months=5)
    elif time_range == '1y':
        start_date = end_date - relativedelta(months=11)
    elif time_range == '5y':
        start_date = end_date - relativedelta(years=4, months=11)
    else:
        start_date = end_date

    start_str = start_date.strftime('%Y-%m-%d')
    end_str   = (end_date + relativedelta(months=1)).strftime('%Y-%m-%d')

    amount_sql_case = f'''
        CASE
            WHEN t.payer = 'Me' THEN {"t.amount" if view_mode == "gross" else "(t.amount - COALESCE(t.reimbursement_amount, 0))"}
            ELSE COALESCE(t.reimbursement_amount, 0)
        END
    '''

    cat_clause = 'AND t.category = %s' if category else ''
    cat_param  = (category,) if category else ()

    tag_placeholders = ','.join(['%s'] * len(tag_ids))
    table_sql = f'''
        SELECT
            t.id, t.date, t.description, t.category,
            ({amount_sql_case}) as display_amount
        FROM transactions t
        WHERE t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id IN ({tag_placeholders}))
        AND COALESCE(t.applied_date, CAST(t.date AS TEXT)) >= %s AND COALESCE(t.applied_date, CAST(t.date AS TEXT)) < %s
        {cat_clause} AND t.is_payment = 0 AND t.user_id = %s
        ORDER BY t.date DESC
    '''
    cursor.execute(table_sql, (*tag_ids, start_str, end_str, *cat_param, current_user.id))
    rows = cursor.fetchall()
    table_data = []
    for r in rows:
        item = dict(r)
        cursor.execute('''
            SELECT tags.id, tags.name
            FROM tags
            JOIN transaction_tags tt ON tags.id = tt.tag_id
            WHERE tt.transaction_id = %s
            ORDER BY tags.name
        ''', (item['id'],))
        item['tags'] = [{'id': tr['id'], 'name': tr['name']} for tr in cursor.fetchall()]
        table_data.append(item)

    graph_data = []
    current_date = start_date
    while current_date <= end_date:
        yr, mo = current_date.strftime('%Y'), current_date.strftime('%m')

        sql = f'''
            SELECT SUM(CASE
                WHEN t.payer = 'Me' THEN {"t.amount" if view_mode == "gross" else "(t.amount - COALESCE(t.reimbursement_amount, 0))"}
                ELSE COALESCE(t.reimbursement_amount, 0)
            END) as total FROM transactions t
            WHERE t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id IN ({tag_placeholders}))
            AND SUBSTR(COALESCE(t.applied_date, CAST(t.date AS TEXT)), 1, 4) = %s
            AND SUBSTR(COALESCE(t.applied_date, CAST(t.date AS TEXT)), 6, 2) = %s
            {cat_clause} AND t.is_payment = 0 AND t.user_id = %s
        '''
        cursor.execute(sql, (*tag_ids, yr, mo, *cat_param, current_user.id))
        month_total = cursor.fetchone()['total'] or 0
        graph_data.append({'month': current_date.strftime('%b %Y'), 'total': month_total})
        current_date += relativedelta(months=1)

    conn.close()
    return jsonify({'table': table_data, 'graph': graph_data})

@app.route('/api/transactions')
def api_transactions():
    from database import get_db_connection
    limit = int(request.args.get('limit', 100))
    conn = get_db_connection()
    cur = conn.cursor()

    cur.execute('''
        SELECT t.id, t.date, t.description, t.amount, t.category, t.bank_category, t.merchant,
               t.card_name, t.is_payment, t.is_shared, t.payer, t.reimbursement_amount,
               t.applied_date,
               (SELECT COUNT(*) FROM settlements s WHERE s.payment_id = t.id OR s.expense_id = t.id) as settlement_count
        FROM transactions t
        WHERE t.user_id = %s
        ORDER BY date DESC
        LIMIT %s
    ''', (current_user.id, limit,))
    rows = cur.fetchall()

    txns = []
    for r in rows:
        txn = dict(r)
        cur.execute('''
            SELECT tags.id, tags.name
            FROM tags
            JOIN transaction_tags tt ON tags.id = tt.tag_id
            WHERE tt.transaction_id = %s
            ORDER BY tags.name
        ''', (txn['id'],))
        txn['tags'] = [{'id': tr['id'], 'name': tr['name']} for tr in cur.fetchall()]
        txns.append(txn)

    conn.close()
    return jsonify(txns)

@app.route('/api/transaction/<int:txn_id>/tag/<int:tag_id>', methods=['DELETE'])
def remove_transaction_tag(txn_id, tag_id):
    from database import get_db_connection
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('SELECT 1 FROM transaction_tags WHERE transaction_id = %s AND tag_id = %s', (txn_id, tag_id))
    if not cur.fetchone():
        conn.close()
        return jsonify({'error': 'Tag not attached to transaction'}), 404

    cur.execute('DELETE FROM transaction_tags WHERE transaction_id = %s AND tag_id = %s', (txn_id, tag_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True}), 200


# ---------------------------------------------------------------------------
# Plaid routes
# ---------------------------------------------------------------------------

@app.route('/api/plaid/link-token', methods=['POST'])
def plaid_link_token():
    try:
        from plaid_integration import create_link_token
        token = create_link_token()
        return jsonify({'link_token': token})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/plaid/exchange-token', methods=['POST'])
def plaid_exchange_token():
    try:
        from plaid_integration import exchange_public_token
        from database import get_db_connection

        data = request.json
        result = exchange_public_token(data['public_token'])

        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('''
            INSERT INTO plaid_accounts
                (item_id, access_token, institution_name, account_name, account_id, user_id)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT(item_id) DO UPDATE SET
                access_token     = excluded.access_token,
                institution_name = excluded.institution_name,
                account_name     = excluded.account_name,
                account_id       = excluded.account_id
        ''', (
            result['item_id'],
            result['access_token'],
            data['institution_name'],
            data['account_name'],
            data['account_id'],
            current_user.id,
        ))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/plaid/accounts', methods=['GET'])
def plaid_accounts():
    from database import get_db_connection
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('SELECT id, institution_name, account_name, account_id, created_at FROM plaid_accounts WHERE user_id = %s',
                (current_user.id,))
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify(rows)


@app.route('/api/plaid/accounts/<int:account_id>', methods=['DELETE', 'PATCH'])
def plaid_modify_account(account_id):
    from database import get_db_connection
    conn = get_db_connection()
    cur = conn.cursor()
    if request.method == 'DELETE':
        cur.execute('DELETE FROM plaid_accounts WHERE id = %s AND user_id = %s', (account_id, current_user.id))
    else:
        new_name = request.json.get('account_name', '').strip()
        if new_name:
            cur.execute('UPDATE plaid_accounts SET account_name = %s WHERE id = %s AND user_id = %s',
                        (new_name, account_id, current_user.id))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/plaid/lookup-shared-profiles', methods=['POST'])
def plaid_lookup_shared_profiles():
    from database import get_db_connection

    descriptions = request.json.get('descriptions', [])
    if not descriptions:
        return jsonify({})

    conn = get_db_connection()
    cur = conn.cursor()
    result = {}

    for desc in descriptions:
        cur.execute('''
            SELECT t.id, t.amount, t.reimbursement_amount,
                   ts.person_name, ts.share_amount
            FROM transactions t
            JOIN transaction_shares ts ON ts.transaction_id = t.id
            WHERE t.description = %s AND t.is_shared = 1 AND t.payer = 'Me' AND t.user_id = %s
            ORDER BY t.date DESC
        ''', (desc, current_user.id))
        rows = cur.fetchall()

        if not rows:
            result[desc] = None
            continue

        txn_map = {}
        for r in rows:
            tid = r['id']
            if tid not in txn_map:
                txn_map[tid] = {'amount': r['amount'], 'shares': []}
            txn_map[tid]['shares'].append({
                'person_name': r['person_name'],
                'share_amount': r['share_amount']
            })

        txns = list(txn_map.values())
        amounts = [t['amount'] for t in txns]
        amount_consistent = len(set(amounts)) == 1
        most_recent = txns[0]

        result[desc] = {
            'amount_consistent': amount_consistent,
            'most_recent_amount': most_recent['amount'],
            'shares': most_recent['shares'],
        }

    conn.close()
    return jsonify(result)

@app.route('/api/plaid/lookup-profiles', methods=['POST'])
def plaid_lookup_profiles():
    from database import get_db_connection

    descriptions = request.json.get('descriptions', [])
    if not descriptions:
        return jsonify({})

    conn = get_db_connection()
    cur = conn.cursor()
    result = {}

    for desc in descriptions:
        cur.execute('''
            SELECT t.id, t.category, STRING_AGG(tg.name, '|||') as tag_names
            FROM transactions t
            LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
            LEFT JOIN tags tg ON tg.id = tt.tag_id
            WHERE t.description = %s AND t.is_payment = 0 AND t.user_id = %s
            GROUP BY t.id, t.category
        ''', (desc, current_user.id))
        rows = cur.fetchall()

        if not rows:
            result[desc] = {'status': 'none'}
            continue

        combos = {}
        for row in rows:
            cat  = row['category'] or ''
            tags = sorted([t for t in (row['tag_names'] or '').split('|||') if t])
            key  = (cat, tuple(tags))
            combos[key] = {'category': cat, 'tags': tags}

        unique_combos = list(combos.values())

        if len(unique_combos) == 1:
            result[desc] = {'status': 'unique', **unique_combos[0]}
        else:
            result[desc] = {'status': 'conflict', 'options': unique_combos}

    conn.close()
    return jsonify(result)


def _filter_internal_transfers(candidates, imported_venmo_transfers=None):
    from datetime import date as date_type

    TRANSFER_PAIRS = [
        ('standard transfer', 'venmo'),
        ('chase credit crd',  'payment thank you-mobile'),
    ]

    to_remove = set()
    for desc_a, desc_b in TRANSFER_PAIRS:
        side_a = [t for t in candidates if t['description'].lower() == desc_a]
        side_b = [t for t in candidates if t['description'].lower() == desc_b]
        for ta in side_a:
            for tb in side_b:
                if abs(ta['amount'] + tb['amount']) < 0.01:
                    date_a = date_type.fromisoformat(ta['date'])
                    date_b = date_type.fromisoformat(tb['date'])
                    if abs((date_a - date_b).days) <= 5:
                        to_remove.add(ta['plaid_transaction_id'])
                        to_remove.add(tb['plaid_transaction_id'])

    # Capital One "Transfer Out From Apps" paired with a Venmo "Account Transfer"
    # of the same amount within 3 days — keep the Venmo side, drop the Capital One side.
    cap_one_app_transfers = [
        t for t in candidates
        if 'capital one' in t.get('card_name', '').lower()
        and t.get('bank_category', '').lower() == 'transfer out transfer out from apps'
    ]
    venmo_account_transfers = [
        t for t in candidates
        if 'venmo' in t.get('card_name', '').lower()
        and t.get('bank_category', '').lower() == 'transfer out account transfer'
    ] + (imported_venmo_transfers or [])
    for tc in cap_one_app_transfers:
        for tv in venmo_account_transfers:
            if abs(tc['amount'] - float(tv['amount'])) < 0.01:
                date_c = date_type.fromisoformat(tc['date'])
                date_v = date_type.fromisoformat(tv['date'])
                if abs((date_c - date_v).days) <= 3:
                    to_remove.add(tc['plaid_transaction_id'])

    kept    = [t for t in candidates if t['plaid_transaction_id'] not in to_remove]
    removed = [t for t in candidates if t['plaid_transaction_id'] in to_remove]
    return kept, removed


def _filter_refund_pairs(candidates):
    from datetime import date as date_type
    from collections import defaultdict

    by_desc = defaultdict(list)
    for t in candidates:
        by_desc[t['description'].lower().strip()].append(t)

    to_remove = set()
    for txns in by_desc.values():
        if len(txns) < 2:
            continue
        for i, ta in enumerate(txns):
            for tb in txns[i + 1:]:
                if abs(ta['amount'] + tb['amount']) < 0.01:
                    date_a = date_type.fromisoformat(ta['date'])
                    date_b = date_type.fromisoformat(tb['date'])
                    if abs((date_a - date_b).days) <= 45:
                        to_remove.add(ta['plaid_transaction_id'])
                        to_remove.add(tb['plaid_transaction_id'])

    kept    = [t for t in candidates if t['plaid_transaction_id'] not in to_remove]
    removed = [t for t in candidates if t['plaid_transaction_id'] in to_remove]
    return kept, removed


@app.route('/api/plaid/fetch-transactions', methods=['POST'])
def plaid_fetch_transactions():
    try:
        from plaid_integration import fetch_transactions
        from database import get_db_connection
        from datetime import date as date_type

        data = request.json
        since_date = date_type.fromisoformat(data.get('since_date'))
        end_date   = date_type.fromisoformat(data.get('end_date')) if data.get('end_date') else date_type.today()

        conn = get_db_connection()
        cur = conn.cursor()

        cur.execute('SELECT * FROM plaid_accounts WHERE user_id = %s', (current_user.id,))
        accounts = [dict(r) for r in cur.fetchall()]

        cur.execute(
            'SELECT plaid_transaction_id FROM transactions WHERE plaid_transaction_id IS NOT NULL AND user_id = %s',
            (current_user.id,)
        )
        existing_ids = {r['plaid_transaction_id'] for r in cur.fetchall()}

        cur.execute(
            """SELECT amount, CAST(date AS TEXT) as date FROM transactions
               WHERE user_id = %s
               AND LOWER(bank_category) = 'transfer out account transfer'
               AND LOWER(card_name) LIKE %s""",
            (current_user.id, '%venmo%')
        )
        imported_venmo_transfers = [dict(r) for r in cur.fetchall()]
        conn.close()

        candidates = []
        for acct in accounts:
            txns = fetch_transactions(acct['access_token'], since_date, [acct['account_id']], end_date)
            for t in txns:
                if t['plaid_transaction_id'] not in existing_ids:
                    t['card_name'] = acct['account_name']
                    t['institution_name'] = acct['institution_name']
                    candidates.append(t)

        candidates, filtered_out = _filter_internal_transfers(candidates, imported_venmo_transfers)
        refund_kept, refund_removed = _filter_refund_pairs(candidates)
        candidates = refund_kept
        filtered_out = filtered_out + refund_removed

        candidates.sort(key=lambda x: x['date'], reverse=True)
        filtered_out.sort(key=lambda x: x['date'], reverse=True)
        return jsonify({'candidates': candidates, 'filtered_out': filtered_out})

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/plaid/import-transactions', methods=['POST'])
def plaid_import_transactions():
    try:
        from database import get_db_connection

        txns = request.json.get('transactions', [])
        conn = get_db_connection()
        cur = conn.cursor()
        inserted = 0

        for t in txns:
            try:
                plaid_id      = t['plaid_transaction_id']
                category      = t.get('category', '')
                resolved_tags = t.get('resolved_tags', [])

                cur.execute('''
                    SELECT id FROM transactions
                    WHERE date = %s AND description = %s AND amount = %s AND card_name = %s
                    AND plaid_transaction_id IS NULL AND user_id = %s
                    LIMIT 1
                ''', (t['date'], t['description'], t['amount'], t.get('card_name', ''), current_user.id))
                existing = cur.fetchone()

                if existing:
                    cur.execute('UPDATE transactions SET plaid_transaction_id = %s WHERE id = %s',
                                (plaid_id, existing['id']))
                    new_id = existing['id']
                else:
                    cur.execute('''
                        INSERT INTO transactions
                            (date, description, merchant, amount, category, bank_category,
                             card_name, is_payment, plaid_transaction_id, user_id)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT DO NOTHING
                    ''', (
                        t['date'], t['description'], t.get('merchant', ''),
                        t['amount'], category,
                        t.get('bank_category', ''), t.get('card_name', ''),
                        1 if t.get('is_payment') else 0,
                        plaid_id,
                        current_user.id,
                    ))
                    if cur.rowcount > 0:
                        new_id = cur.lastrowid
                        inserted += 1
                    else:
                        cur.execute('''
                            UPDATE transactions SET plaid_transaction_id = %s
                            WHERE date = %s AND description = %s AND amount = %s
                              AND card_name = %s AND user_id = %s
                        ''', (plaid_id, t['date'], t['description'], t['amount'],
                              t.get('card_name', ''), current_user.id))
                        new_id = None

                if new_id and resolved_tags:
                    for tag_name in resolved_tags:
                        cur.execute('SELECT id FROM tags WHERE name = %s', (tag_name,))
                        tag_row = cur.fetchone()
                        if tag_row:
                            tag_id = tag_row['id']
                        else:
                            cur.execute('INSERT INTO tags (name) VALUES (%s)', (tag_name,))
                            tag_id = cur.lastrowid
                        cur.execute(
                            'INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (%s, %s) ON CONFLICT DO NOTHING',
                            (new_id, tag_id)
                        )

                resolved_shares = t.get('resolved_shares')
                if new_id and resolved_shares:
                    cur.execute('UPDATE transactions SET is_shared = 1, payer = %s WHERE id = %s AND user_id = %s',
                                ('Me', new_id, current_user.id))
                    cur.execute('DELETE FROM transaction_shares WHERE transaction_id = %s', (new_id,))
                    total_reimbursement = 0
                    for share in resolved_shares:
                        amt = float(share.get('share_amount', 0))
                        total_reimbursement += amt
                        cur.execute(
                            'INSERT INTO transaction_shares (transaction_id, person_name, share_amount) VALUES (%s, %s, %s)',
                            (new_id, share.get('person_name'), amt)
                        )
                    cur.execute('UPDATE transactions SET reimbursement_amount = %s WHERE id = %s AND user_id = %s',
                                (total_reimbursement, new_id, current_user.id))

            except Exception:
                pass

        conn.commit()
        conn.close()
        return jsonify({'success': True, 'inserted': inserted})

    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
