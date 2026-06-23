from flask import Flask, render_template, request, jsonify
import pandas as pd
import sqlite3
import os
from datetime import datetime
from dotenv import load_dotenv
from database import init_db, insert_transactions, get_monthly_summary

load_dotenv()

app = Flask(__name__)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB max file size

# Ensure upload folder exists
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Initialize database
init_db()

@app.route('/')
def index():
    from database import TRACKED_CATEGORIES
    return render_template('index.html', tracked_categories=TRACKED_CATEGORIES)

@app.route('/upload', methods=['POST'])
def upload_csv():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part in the request'}), 400
    
    file = request.files['file']
    
    # NEW: Get the bank name selected by the user in the dropdown
    # If for some reason it's missing, we default to 'Unknown'
    bank_name = request.form.get('bank_name', 'Unknown')
    
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if file and file.filename.lower().endswith('.csv'):
        try:
            # Try utf-8 first, then fallback to latin1 for bank files with special characters
            try:
                df = pd.read_csv(file, encoding='utf-8')
            except UnicodeDecodeError:
                file.seek(0) # Reset file pointer for second read attempt
                df = pd.read_csv(file, encoding='latin1')
            
            # UPDATED: Pass the user-selected bank_name instead of file.filename
            count = process_csv(df, card_name=bank_name)
            
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
    # Get monthly summary data
    summary = get_monthly_summary()
    return jsonify(summary)

def process_csv(df, card_name="Unknown"):
    # 1. Standardize headers
    df.columns = [c.strip().lower() for c in df.columns]
    headers = df.columns
    
    # 2. Detect Columns
    date_col = next((h for h in headers if 'date' in h), None)
    desc_col = next((h for h in headers if 'description' in h or 'memo' in h or 'name' in h), None)
    amt_col = next((h for h in headers if 'amount' in h or 'charge' in h or 'value' in h), None)
    
    cat_options = ['category', 'transaction type', 'type', 'group', 'class', 'memo']
    cat_col = next((h for h in headers if any(opt in h for opt in cat_options)), None)

    if not all([date_col, desc_col, amt_col]):
        print(f"Missing core columns in {card_name}. Headers found: {list(headers)}")
        return 0

    final_data = []
    seen_in_batch = {} # Tracks duplicates within the current CSV
    
    for _, row in df.iterrows():
        try:
            if pd.isna(row[date_col]) or pd.isna(row[amt_col]):
                continue

            description = str(row[desc_col]).strip()
            raw_amt = float(str(row[amt_col]).replace('$', '').replace(',', '').replace('(', '-').replace(')', ''))
            
            # Extract the bank's category
            bank_cat = str(row[cat_col]) if cat_col and pd.notna(row[cat_col]) else 'Uncategorized'
            
            # 3. Logic for is_payment
            txn_type_val = bank_cat.lower()
            is_payment = 0
            if any(word in txn_type_val for word in ['payment', 'credit', 'return']):
                is_payment = 1
            elif any(word in description.lower() for word in ['payment', 'thank you', 'tfr-out', 'credit']):
                is_payment = 1

            # 4. Standardize Amount & Sign Flip Refinement
            # Spending (Expenses) should always be stored as POSITIVE for budget math.
            if is_payment == 0:
                # For Expenses, we use abs() to ensure it's a positive cost
                clean_amount = abs(raw_amt)
            else:
                # For Payments/Credits, we keep the original sign.
                # If you find a specific bank like Venmo flips these, 
                # you can add: if card_name == 'Venmo': clean_amount = raw_amt * -1
                clean_amount = raw_amt

            # 5. Standardize Date
            clean_date = pd.to_datetime(row[date_col]).strftime('%Y-%m-%d')

            # 6. Internal De-duplication (The "Metro Ticket" fix)
            # If we see the exact same transaction multiple times in one file, 
            # we append a counter so the database UNIQUE constraint allows it.
            key = (clean_date, description, clean_amount, card_name)
            occurrence = seen_in_batch.get(key, 0) + 1
            seen_in_batch[key] = occurrence
            
            db_description = f"{description} ({occurrence})" if occurrence > 1 else description

            final_data.append((
                clean_date, 
                db_description, 
                clean_amount, 
                bank_cat,     # initial user_category
                bank_cat,     # permanent bank_category
                db_description,  # merchant
                card_name,    # This now comes from your UI dropdown (Chase, CapOne, etc.)
                int(is_payment)
            ))
        except Exception as e:
            print(f"Error on row: {e}")
            continue

    if final_data:
        from database import insert_transactions#, apply_rules_to_all
        count = insert_transactions(final_data)
        #apply_rules_to_all()
        return count
    return 0


@app.route('/api/transaction/<int:txn_id>/toggle-shared', methods=['POST'])
def toggle_shared(txn_id):
    import sqlite3
    conn = sqlite3.connect('budget.db')
    cursor = conn.cursor()
    # Flip the boolean
    cursor.execute('UPDATE transactions SET is_shared = 1 - is_shared WHERE id = ?', (txn_id,))
    conn.commit()
    conn.close()
    return jsonify({'success': True})

@app.route('/api/transaction/<int:txn_id>', methods=['DELETE'])
def delete_transaction(txn_id):
    try:
        from database import get_db_connection
        conn = get_db_connection()
        cursor = conn.cursor()

        # 1. Delete associated settlements (cascade cleanup)
        cursor.execute('DELETE FROM settlements WHERE payment_id = ? OR expense_id = ?', (txn_id, txn_id))
        
        # 2. Delete associated shares
        cursor.execute('DELETE FROM transaction_shares WHERE transaction_id = ?', (txn_id,))

        # 3. Delete the transaction record
        cursor.execute('DELETE FROM transactions WHERE id = ?', (txn_id,))
        conn.commit()
        conn.close()
        return jsonify({'success': True, 'message': 'Transaction deleted'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/categories')
def get_categories():
    from database import get_category_breakdown
    # This returns category and total_spent
    categories = get_category_breakdown()
    return jsonify(categories)

@app.route('/api/rules', methods=['GET', 'POST'])
def manage_rules():
    from database import add_rule, get_all_rules, apply_rules_to_all
    if request.method == 'POST':
        data = request.json
        add_rule(data['keyword'], data['category'], data.get('amount'))
        apply_rules_to_all() # Re-scan DB with the new rule
        return jsonify({'success': True})
    
    return jsonify(get_all_rules())

@app.route('/api/rules/<int:rule_id>', methods=['DELETE'])
def delete_rule(rule_id):
    try:
        from database import get_db_connection
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute('DELETE FROM category_rules WHERE id = ?', (rule_id,))
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
    data = get_detailed_breakdown(year, month)
    return jsonify(data)

@app.route('/api/overview-history')
def overview_history():
    year = request.args.get('year')
    month = request.args.get('month')
    view_mode = request.args.get('view_mode', 'gross')
    time_range = request.args.get('time_range', '1y')

    from database import get_overview_history
    data = get_overview_history(year, month, view_mode, time_range)
    return jsonify(data)


@app.route('/api/transaction/<int:txn_id>/toggle-payment', methods=['POST'])
def toggle_payment(txn_id):
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute('UPDATE transactions SET is_payment = 1 - is_payment WHERE id = ?', (txn_id,))
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
        
        # Pull is_payment from the request, default to 0 (expense)
        is_pay = data.get('is_payment', 0)
        
        # Also handle is_shared if it was sent
        is_shared = data.get('is_shared', 0)
        payer = data.get('payer', 'Me')
        shares = data.get('shares', [])

        cursor.execute('''
            INSERT INTO transactions 
            (date, description, amount, category, bank_category, card_name, is_payment, is_shared, payer, is_manual_category)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ''', (
            data['date'], 
            data['description'], 
            data['amount'], 
            data['category'], 
            data['category'], 
            data['account'],
            is_pay,
            is_shared,
            payer
        ))
        txn_id = cursor.lastrowid

        if is_shared == 1:
            total_reimb = 0
            for share in shares:
                amt = float(share.get('amount', 0))
                total_reimb += amt
                cursor.execute('INSERT INTO transaction_shares (transaction_id, person_name, share_amount) VALUES (?, ?, ?)',
                               (txn_id, share.get('name'), amt))
            cursor.execute('UPDATE transactions SET reimbursement_amount = ? WHERE id = ?', (total_reimb, txn_id))
        
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
        
        # Shared status: 1 (Shared), 0 (Personal), or None (No Change)
        is_shared = data.get('is_shared')
        payer = data.get('payer')
        
        # New: The list of people and their specific shares
        # Expects: [{"name": "Alice", "amount": 10.50}, ...]
        shares = data.get('shares', [])
        
        from database import get_db_connection
        conn = get_db_connection()
        cursor = conn.cursor()
        
        for txn_id in ids:
            # 1. Update description/merchant only if a new one was provided
            if new_desc:
                cursor.execute('''
                    UPDATE transactions 
                    SET description = ?, merchant = ? 
                    WHERE id = ?
                ''', (new_desc, new_desc, txn_id))
            
            # 2. Update category only if a value was selected
            if new_cat:
                cursor.execute('''
                    UPDATE transactions 
                    SET category = ?, is_manual_category = 1 
                    WHERE id = ?
                ''', (new_cat, txn_id))
            
            # 3. Handle Shared Status & Multi-Person Splits
            if is_shared is not None:
                # Save old share IDs to re-link settlements after recreation
                cursor.execute('SELECT id, person_name FROM transaction_shares WHERE transaction_id = ?', (txn_id,))
                old_shares = {row['person_name']: row['id'] for row in cursor.fetchall()}

                # Update the basic flag and payer
                cursor.execute('''
                    UPDATE transactions 
                    SET is_shared = ?, payer = ? 
                    WHERE id = ?
                ''', (is_shared, payer or 'Me', txn_id))

                # Clean out any old shares for these transactions
                cursor.execute('DELETE FROM transaction_shares WHERE transaction_id = ?', (txn_id,))

                if is_shared == 1:
                    total_reimbursement = 0
                    for share in shares:
                        name = share.get('name')
                        amt = float(share.get('amount', 0))
                        total_reimbursement += amt
                        
                        # Insert individual share record
                        cursor.execute('''
                            INSERT INTO transaction_shares (transaction_id, person_name, share_amount)
                            VALUES (?, ?, ?)
                        ''', (txn_id, name, amt))
                        new_share_id = cursor.lastrowid

                        # RE-LINK: If this person had a share before, update settlements to use the new ID
                        if name in old_shares:
                            old_sid = old_shares[name]
                            cursor.execute('UPDATE settlements SET payment_share_id = ? WHERE payment_share_id = ?', (new_share_id, old_sid))
                            cursor.execute('UPDATE settlements SET expense_share_id = ? WHERE expense_share_id = ?', (new_share_id, old_sid))
                    
                    # Update the total reimbursement sum so the Overview Toggle still works
                    cursor.execute('UPDATE transactions SET reimbursement_amount = ? WHERE id = ?', 
                                   (total_reimbursement, txn_id))
                else:
                    # If set back to Personal, reset the reimbursement sum
                    cursor.execute('UPDATE transactions SET reimbursement_amount = 0 WHERE id = ?', (txn_id,))
        
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        print(f"Bulk Edit Error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500


@app.route('/api/shared-ledger')
def shared_ledger():
    person_filter = request.args.get('person', '')
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. Get all unique people for the dropdown
    cursor.execute('''
        SELECT DISTINCT name FROM (
            SELECT person_name as name FROM transaction_shares
            UNION
            SELECT payer as name FROM transactions
        ) WHERE name != "Me" AND name IS NOT NULL AND name != "" ORDER BY name
    ''')
    all_people_names = [row['name'] for row in cursor.fetchall()]

    # Calculate balance for each person to categorize them
    people_with_balances = []
    for person_name in all_people_names:
        balance_sql = '''
            SELECT SUM(CASE WHEN t.payer = 'Me' THEN ts.share_amount ELSE -ts.share_amount END) as balance
            FROM transactions t
            JOIN transaction_shares ts ON t.id = ts.transaction_id
            WHERE t.is_shared = 1 AND (
                (t.payer = 'Me' AND ts.person_name = ?) OR
                (t.payer = ? AND ts.person_name = 'Me')
            )
        '''
        cursor.execute(balance_sql, (person_name, person_name))
        result = cursor.fetchone()
        balance = result['balance'] if result and result['balance'] is not None else 0
        people_with_balances.append({'name': person_name, 'balance': balance})

    # Create the structured list for the dropdown
    people_data = {
        "owes_me": sorted([p for p in people_with_balances if p['balance'] > 0.01], key=lambda x: x['balance'], reverse=True),
        "i_owe": sorted([p for p in people_with_balances if p['balance'] < -0.01], key=lambda x: x['balance']),
        "settled": sorted([p for p in people_with_balances if -0.01 <= p['balance'] <= 0.01], key=lambda x: x['name'])
    }

    ledger = []
    net_balance = 0

    # Unified Ledger Query
    # If person_filter exists: limit to items between Me and that person
    # If no filter: show all shared items where I am either the payer or the shareholder
    sql = '''
        SELECT t.id, t.date, t.description, t.payer, ts.share_amount, t.is_payment, ts.person_name
        FROM transactions t
        JOIN transaction_shares ts ON t.id = ts.transaction_id
        WHERE t.is_shared = 1 AND (
            (t.payer = 'Me' AND ts.person_name != 'Me' {filter_clause_payer}) OR
            (t.payer != 'Me' AND ts.person_name = 'Me' {filter_clause_share})
        )
        ORDER BY t.date ASC
    '''
    
    filter_payer = "AND ts.person_name = ?" if person_filter else ""
    filter_share = "AND t.payer = ?" if person_filter else ""
    
    query = sql.format(filter_clause_payer=filter_payer, filter_clause_share=filter_share)
    params = (person_filter, person_filter) if person_filter else ()

    cursor.execute(query, params)
    rows = cursor.fetchall()

    running_bal = 0
    for row in rows:
        amt = float(row['share_amount'])
        # Logic: 
        # 1. If I paid: it's a positive increase to the balance (others owe me)
        # 2. If they paid: it's a negative decrease (I owe them)
        change = amt if row['payer'] == 'Me' else -amt
        
        running_bal += change
        item = dict(row)
        item['net_change'] = change
        item['running_balance'] = running_bal
        
        # Fetch tags for this transaction
        cursor.execute('''
            SELECT tags.id, tags.name
            FROM tags
            JOIN transaction_tags tt ON tags.id = tt.tag_id
            WHERE tt.transaction_id = ?
            ORDER BY tags.name
        ''', (item['id'],))
        item['tags'] = [{'id': tr['id'], 'name': tr['name']} for tr in cursor.fetchall()]
        
        ledger.append(item)

    net_balance = running_bal
    # Reverse for display (Newest at top)
    ledger.reverse()

    conn.close()
    return jsonify({
        'people': people_data,
        'ledger': ledger,
        'net_balance': net_balance
    })


@app.route('/api/people')
def get_people():
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()
    # Pull unique names from both payers and shares
    cursor.execute('''
        SELECT DISTINCT name FROM (
            SELECT person_name as name FROM transaction_shares
            UNION
            SELECT payer as name FROM transactions
        ) WHERE name IS NOT NULL AND name != "" ORDER BY name
    ''')
    people = [row['name'] for row in cursor.fetchall()]
    conn.close()
    return jsonify(people)

@app.route('/api/transaction/<int:txn_id>/details')
def get_transaction_details(txn_id):
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. Get the main transaction data
    cursor.execute('SELECT * FROM transactions WHERE id = ?', (txn_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Transaction not found'}), 404
    txn = dict(row)
    
    # NEW: Check for settlements
    cursor.execute('SELECT COUNT(*) FROM settlements WHERE payment_id = ? OR expense_id = ?', (txn_id, txn_id))
    txn['settlement_count'] = cursor.fetchone()[0]

    # 2. Get the associated shares
    cursor.execute('SELECT person_name, share_amount FROM transaction_shares WHERE transaction_id = ?', (txn_id,))
    shares = [dict(row) for row in cursor.fetchall()]
    
    conn.close()
    return jsonify({**txn, 'shares': shares})

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
        
        # Ensure tag exists
        cursor.execute('INSERT OR IGNORE INTO tags (name) VALUES (?)', (tag_name,))
        cursor.execute('SELECT id FROM tags WHERE name = ?', (tag_name,))
        tag_id = cursor.fetchone()[0]
        
        # Add tag to selected transactions
        for txn_id in ids:
            cursor.execute('INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)', (txn_id, tag_id))
        
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    
    cursor.execute('SELECT * FROM tags ORDER BY name')
    tags = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return jsonify(tags)

@app.route('/api/tag/<int:tag_id>', methods=['DELETE'])
def delete_tag(tag_id):
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute('DELETE FROM transaction_tags WHERE tag_id = ?', (tag_id,))
        cursor.execute('DELETE FROM tag_defaults WHERE tag_id = ?', (tag_id,))
        cursor.execute('DELETE FROM tags WHERE id = ?', (tag_id,))
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
        cursor.execute('DELETE FROM tag_defaults WHERE category = ?', (category,))
        for tid in tag_ids:
            cursor.execute('INSERT INTO tag_defaults (category, tag_id) VALUES (?, ?)', (category, tid))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    
    category = request.args.get('category')
    cursor.execute('SELECT tag_id FROM tag_defaults WHERE category = ?', (category,))
    defaults = [row[0] for row in cursor.fetchall()]
    conn.close()
    return jsonify(defaults)

@app.route('/api/breakdown-report')
def breakdown_report():
    year = request.args.get('year')
    month = request.args.get('month')
    category = request.args.get('category')
    tag_ids = request.args.getlist('tag_ids', type=int)
    view_mode = request.args.get('view_mode', 'gross')
    time_range = request.args.get('time_range', '1y') # Default to 1 year
    
    from database import get_db_connection
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. Table Data: Totals per tag for the selected period
    amount_sql_case = f'''
        CASE 
            WHEN t.payer = 'Me' THEN {"t.amount" if view_mode == "gross" else "(t.amount - COALESCE(t.reimbursement_amount, 0))"}
            ELSE COALESCE(t.reimbursement_amount, 0)
        END
    '''
    
    table_sql = f'''
        SELECT 
            t.id, t.date, t.description,
            ({amount_sql_case}) as display_amount
        FROM transactions t
        WHERE t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id IN ({",".join(["?"]*len(tag_ids))}))
        AND strftime('%Y', date) = ? AND strftime('%m', date) = ? 
        AND t.category = ? AND t.is_payment = 0
        ORDER BY t.date DESC
    '''
    cursor.execute(table_sql, (*tag_ids, year, month, category))
    rows = cursor.fetchall()
    table_data = []
    for r in rows:
        item = dict(r)
        cursor.execute('''
            SELECT tags.id, tags.name
            FROM tags
            JOIN transaction_tags tt ON tags.id = tt.tag_id
            WHERE tt.transaction_id = ?
            ORDER BY tags.name
        ''', (item['id'],))
        item['tags'] = [{'id': tr['id'], 'name': tr['name']} for tr in cursor.fetchall()]
        table_data.append(item)

    # 2. Graph Data: 12-month history of the aggregate spend for the selected tags
    graph_data = []
    from dateutil.relativedelta import relativedelta
    
    # The end date is now the selected month and year from the dropdowns
    end_date = datetime(int(year), int(month), 1)

    # Determine the start date for the graph relative to the end_date
    if time_range == '3m':
        start_date = end_date - relativedelta(months=2)
    elif time_range == '6m':
        start_date = end_date - relativedelta(months=5)
    elif time_range == '1y':
        start_date = end_date - relativedelta(months=11)
    elif time_range == '5y':
        start_date = end_date - relativedelta(years=4, months=11)
    
    # Generate monthly totals within the range
    current_date = start_date
    while current_date <= end_date:
        yr, mo = current_date.strftime('%Y'), current_date.strftime('%m')
        
        # Distinct transaction IDs having any of the selected tags to avoid double-counting in the aggregate chart
        sql = f'''
            SELECT SUM(CASE 
                WHEN t.payer = 'Me' THEN {"t.amount" if view_mode == "gross" else "(t.amount - COALESCE(t.reimbursement_amount, 0))"}
                ELSE COALESCE(t.reimbursement_amount, 0)
            END) FROM transactions t
            WHERE t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id IN ({",".join(["?"]*len(tag_ids))}))
            AND strftime('%Y', date) = ? AND strftime('%m', date) = ? 
            AND t.category = ? AND t.is_payment = 0
        '''
        cursor.execute(sql, (*tag_ids, yr, mo, category))
        month_total = cursor.fetchone()[0] or 0
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
               (SELECT COUNT(*) FROM settlements s WHERE s.payment_id = t.id OR s.expense_id = t.id) as settlement_count
        FROM transactions t
        ORDER BY date DESC
        LIMIT ?
    ''', (limit,))
    rows = cur.fetchall()

    txns = []
    for r in rows:
        txn = dict(r)
        # fetch tags for this transaction
        cur.execute('''
            SELECT tags.id, tags.name
            FROM tags
            JOIN transaction_tags tt ON tags.id = tt.tag_id
            WHERE tt.transaction_id = ?
            ORDER BY tags.name
        ''', (txn['id'],))
        tags = [{'id': tr['id'], 'name': tr['name']} for tr in cur.fetchall()]
        txn['tags'] = tags
        txns.append(txn)

    conn.close()
    return jsonify(txns)

# DELETE /api/transaction/<txn_id>/tag/<tag_id>
@app.route('/api/transaction/<int:txn_id>/tag/<int:tag_id>', methods=['DELETE'])
def remove_transaction_tag(txn_id, tag_id):
    from database import get_db_connection
    conn = get_db_connection()
    cur = conn.cursor()
    # Ensure relationship exists (optional)
    cur.execute('SELECT 1 FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?', (txn_id, tag_id))
    if not cur.fetchone():
        conn.close()
        return jsonify({'error': 'Tag not attached to transaction'}), 404

    cur.execute('DELETE FROM transaction_tags WHERE transaction_id = ? AND tag_id = ?', (txn_id, tag_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True}), 200


# ---------------------------------------------------------------------------
# Plaid routes
# ---------------------------------------------------------------------------

@app.route('/api/plaid/link-token', methods=['POST'])
def plaid_link_token():
    """Returns a short-lived Link token the frontend uses to open Plaid Link."""
    try:
        from plaid_integration import create_link_token
        token = create_link_token()
        return jsonify({'link_token': token})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/plaid/exchange-token', methods=['POST'])
def plaid_exchange_token():
    """
    Called after the user successfully connects a bank in Plaid Link.
    Exchanges the temporary public_token for a permanent access_token and
    stores the account in plaid_accounts.
    Body: { public_token, institution_name, account_name, account_id }
    """
    try:
        from plaid_integration import exchange_public_token
        from database import get_db_connection

        data = request.json
        result = exchange_public_token(data['public_token'])

        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('''
            INSERT OR REPLACE INTO plaid_accounts
                (item_id, access_token, institution_name, account_name, account_id)
            VALUES (?, ?, ?, ?, ?)
        ''', (
            result['item_id'],
            result['access_token'],
            data['institution_name'],
            data['account_name'],
            data['account_id'],
        ))
        conn.commit()
        conn.close()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/plaid/accounts', methods=['GET'])
def plaid_accounts():
    """Returns the list of connected bank accounts (no tokens exposed)."""
    from database import get_db_connection
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('SELECT id, institution_name, account_name, account_id, created_at FROM plaid_accounts')
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return jsonify(rows)


@app.route('/api/plaid/accounts/<int:account_id>', methods=['DELETE', 'PATCH'])
def plaid_modify_account(account_id):
    from database import get_db_connection
    conn = get_db_connection()
    cur = conn.cursor()
    if request.method == 'DELETE':
        cur.execute('DELETE FROM plaid_accounts WHERE id = ?', (account_id,))
    else:  # PATCH — rename
        new_name = request.json.get('account_name', '').strip()
        if new_name:
            cur.execute('UPDATE plaid_accounts SET account_name = ? WHERE id = ?', (new_name, account_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/plaid/lookup-profiles', methods=['POST'])
def plaid_lookup_profiles():
    """
    Given a list of transaction descriptions, returns the category+tags
    profile(s) already in the DB for each one.

    Response shape per description:
      { status: 'unique',   category: '...', tags: ['...'] }   — one consistent profile
      { status: 'conflict', options: [{category, tags}, ...] } — multiple different profiles
      { status: 'none' }                                        — no existing transactions
    """
    from database import get_db_connection

    descriptions = request.json.get('descriptions', [])
    if not descriptions:
        return jsonify({})

    conn = get_db_connection()
    cur = conn.cursor()
    result = {}

    for desc in descriptions:
        # Fetch all distinct (category, tag list) combos for this description
        cur.execute('''
            SELECT t.id, t.category, GROUP_CONCAT(tg.name, '|||') as tag_names
            FROM transactions t
            LEFT JOIN transaction_tags tt ON tt.transaction_id = t.id
            LEFT JOIN tags tg ON tg.id = tt.tag_id
            WHERE t.description = ? AND t.is_payment = 0
            GROUP BY t.id
        ''', (desc,))
        rows = cur.fetchall()

        if not rows:
            result[desc] = {'status': 'none'}
            continue

        # Build a set of distinct (category, frozenset of tags) combos
        combos = {}
        for row in rows:
            cat = row['category'] or ''
            tags = sorted([t for t in (row['tag_names'] or '').split('|||') if t])
            key = (cat, tuple(tags))
            combos[key] = {'category': cat, 'tags': tags}

        unique_combos = list(combos.values())

        if len(unique_combos) == 1:
            result[desc] = {'status': 'unique', **unique_combos[0]}
        else:
            result[desc] = {'status': 'conflict', 'options': unique_combos}

    conn.close()
    return jsonify(result)


@app.route('/api/plaid/fetch-transactions', methods=['POST'])
def plaid_fetch_transactions():
    """
    Fetches candidate transactions from all connected accounts starting from
    the given date, filters out any already in the DB, and returns the
    remainder for the user to review and selectively import.
    Body: { since_date: 'YYYY-MM-DD' }
    """
    try:
        from plaid_integration import fetch_transactions
        from database import get_db_connection
        from datetime import date as date_type

        data = request.json
        since_date = date_type.fromisoformat(data.get('since_date'))

        conn = get_db_connection()
        cur = conn.cursor()

        # Load all connected accounts
        cur.execute('SELECT * FROM plaid_accounts')
        accounts = [dict(r) for r in cur.fetchall()]

        # Load existing plaid IDs so we can deduplicate
        cur.execute('SELECT plaid_transaction_id FROM transactions WHERE plaid_transaction_id IS NOT NULL')
        existing_ids = {r[0] for r in cur.fetchall()}
        conn.close()

        candidates = []
        for acct in accounts:
            txns = fetch_transactions(acct['access_token'], since_date, [acct['account_id']])
            for t in txns:
                if t['plaid_transaction_id'] not in existing_ids:
                    t['card_name'] = acct['account_name']
                    t['institution_name'] = acct['institution_name']
                    candidates.append(t)

        # Sort newest first so the most recent transactions are at the top
        candidates.sort(key=lambda x: x['date'], reverse=True)
        return jsonify(candidates)

    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/plaid/import-transactions', methods=['POST'])
def plaid_import_transactions():
    """
    Inserts the user-selected transactions into the DB.
    Body: { transactions: [ ...shaped transaction dicts... ] }
    """
    try:
        from database import get_db_connection

        txns = request.json.get('transactions', [])
        conn = get_db_connection()
        cur = conn.cursor()
        inserted = 0

        for t in txns:
            try:
                plaid_id = t['plaid_transaction_id']
                category = t.get('category', '')
                resolved_tags = t.get('resolved_tags', [])

                # Check if there's an existing CSV-imported row to backfill
                cur.execute('''
                    SELECT id FROM transactions
                    WHERE date = ? AND description = ? AND amount = ? AND card_name = ?
                    AND plaid_transaction_id IS NULL
                    LIMIT 1
                ''', (t['date'], t['description'], t['amount'], t.get('card_name', '')))
                existing = cur.fetchone()

                if existing:
                    cur.execute('UPDATE transactions SET plaid_transaction_id = ? WHERE id = ?',
                                (plaid_id, existing[0]))
                    new_id = existing[0]
                else:
                    cur.execute('''
                        INSERT OR IGNORE INTO transactions
                            (date, description, merchant, amount, category, bank_category,
                             card_name, is_payment, plaid_transaction_id)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (
                        t['date'], t['description'], t.get('merchant', ''),
                        t['amount'], category,
                        t.get('bank_category', ''), t.get('card_name', ''),
                        1 if t.get('is_payment') else 0,
                        plaid_id,
                    ))
                    new_id = cur.lastrowid
                    if new_id:
                        inserted += 1

                # Apply resolved tags if any
                if new_id and resolved_tags:
                    for tag_name in resolved_tags:
                        # Get or create the tag
                        cur.execute('SELECT id FROM tags WHERE name = ?', (tag_name,))
                        tag_row = cur.fetchone()
                        if tag_row:
                            tag_id = tag_row[0]
                        else:
                            cur.execute('INSERT INTO tags (name) VALUES (?)', (tag_name,))
                            tag_id = cur.lastrowid
                        # Attach to the transaction (ignore if already linked)
                        cur.execute('''
                            INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id)
                            VALUES (?, ?)
                        ''', (new_id, tag_id))

            except Exception:
                pass

        conn.commit()
        conn.close()
        return jsonify({'success': True, 'inserted': inserted})

    except Exception as e:
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)