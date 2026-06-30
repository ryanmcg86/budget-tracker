# Spending Tracker

A personal finance web app built with Flask. Transactions can be imported via CSV upload or fetched live from connected bank accounts through the Plaid API. The app tracks spending by category, handles shared expenses and bill splitting across multiple people, and provides detailed breakdowns with tagging and saved views.

Access is invite-only — there is no public registration. Each user's data is fully isolated; every query is scoped to `current_user.id`.

The UI is fully responsive: breakpoints at 1024px (tablet landscape), 768px (tablet/phone), and 480px (small phone). Phase 1 foundation CSS is in place; the mobile redesign is ongoing.

Runs on **SQLite locally** (zero config) and **PostgreSQL in production** (auto-detected via `DATABASE_URL`).

---

## Project Structure

```
spending-tracker/
├── app.py                    # Flask application — all API routes
├── auth.py                   # Flask-Login setup, User model, login/logout/register routes
├── create_user.py            # CLI script to create user accounts directly (bypasses invite flow)
├── create_invite.py          # CLI script to generate single-use invite codes
├── database.py               # DB connection wrappers, schema, migrations, query helpers
├── migrate_to_postgres.py    # One-time script to copy SQLite data into PostgreSQL
├── plaid_integration.py      # Plaid API client (link tokens, token exchange, transaction fetch)
├── static/js/main.js         # All frontend logic (vanilla JS + Plotly)
├── static/css/style.css      # Dark-theme stylesheet
├── templates/index.html      # Single-page HTML shell (authenticated)
├── templates/login.html      # Login page
├── .python-version           # Pins Python 3.11.9 for Render (avoids pandas/numpy incompatibility on 3.14)
└── budget.db                 # SQLite database (auto-created on first run; local dev only)
```

---

## Scripts

<details>
<summary><strong>auth.py</strong></summary>

Owns the authentication layer. Imported by `app.py` at startup.

### Classes

**`User(UserMixin)`**
Flask-Login user model. Holds `id` and `email`. `User.get(user_id)` loads by primary key; `User.get_by_email(email)` returns the full row including `password_hash` for login verification.

### Routes

**`GET|POST /login`**
Renders the login form (GET) or validates credentials and creates a session (POST). Passwords are verified with bcrypt. Sessions persist across browser restarts (`remember=True`).

**`GET|POST /register`**
Invite-gated registration. GET renders the form (invite code + email + password). POST validates the code against `invite_codes` (must exist and be unused), creates the user, marks the code as used with a timestamp and the new email, then logs the user in and redirects to the app.

**`POST /api/generate-invite`**
Admin-only (user_id == 1). Generates a random `XXXX-XXXX` invite code, stores it in `invite_codes`, and returns it as JSON. Surfaced in Settings → Account → Invite Codes for easy in-app code generation.

**`GET /logout`**
Clears the session and redirects to `/login`.

</details>

---

<details>
<summary><strong>create_user.py</strong></summary>

Invite-only user creation CLI. Run directly on the server — there is no self-registration flow.

```bash
python create_user.py
```

Prompts for email and password (with confirmation), hashes the password with bcrypt, and inserts a row into the `users` table. Enforces a minimum password length of 8 characters.

</details>

---

<details>
<summary><strong>database.py</strong></summary>

Owns the database layer. All other files import from here rather than opening the database directly.

### Dual-database design

All SQL is written with `%s` placeholders (PostgreSQL style). When `DATABASE_URL` is not set, `get_db_connection()` returns a `_SQLiteConn` wrapper that transparently converts `%s` → `?` before executing each query, so SQLite works without any changes to the calling code. When `DATABASE_URL` is set, a psycopg2 connection wrapped in `_PGConn` is returned instead; both wrappers expose the same interface (`cursor()`, `execute()`, `commit()`, `close()`, `rollback()`).

Row results support dict-style access (`row['column']`) in both modes: SQLite uses `row_factory = sqlite3.Row`; PostgreSQL uses `RealDictCursor`.

`_PGConn` also registers a psycopg2 type adapter on every new connection so that `DATE` columns are returned as `"YYYY-MM-DD"` strings instead of Python `datetime.date` objects, matching SQLite's behaviour and avoiding type errors in any Python code that calls string methods on date values.

### Constants

**`DEFAULT_CATEGORIES`**
The seed list of ten spending categories used to populate the `categories` table on first run. The live source of truth is the `categories` table; call `get_categories(user_id)` to get the current ordered list.

**`TRACKED_CATEGORIES`**
Alias for `DEFAULT_CATEGORIES`. Kept for backwards compatibility with any external imports.

### Database Schema

| Table | Purpose |
|---|---|
| `users` | Registered accounts (email, bcrypt password hash, display name) |
| `transactions` | Core transaction ledger |
| `payment_splits` | Sub-rows that divide a lump payment across multiple applied dates |
| `transaction_shares` | Per-person share amounts for a shared transaction |
| `settlements` | Records when a shared-expense payment is matched against an expense |
| `categories` | Per-user ordered category name registry |
| `tags` | Per-user tag name registry |
| `transaction_tags` | Many-to-many link between transactions and tags |
| `tag_defaults` | Default tags to apply per category on the Detailed Breakdowns page |
| `plaid_accounts` | Connected bank accounts (stores Plaid access tokens) |
| `breakdown_views` | Saved tag+category combinations for the Detailed Breakdowns page |

**User isolation:** all tables except `settlements`, `payment_splits`, and `transaction_tags` carry a `user_id` column. Those three tables are scoped indirectly via their parent transaction's `user_id`. All queries filter by `user_id`; `init_db()` backfills existing rows to `user_id = 1` on startup.

**Key `transactions` columns:**
- `amount` — expenses stored as positive; payments/credits stored with original sign
- `is_payment` — 0 = expense, 1 = income/payment
- `is_shared` — marks transactions that involve cost-sharing with other people
- `payer` — `"Me"` or the name of whoever physically paid; `"Me"` means I fronted the money
- `reimbursement_amount` — automatically maintained sum of all `transaction_shares.share_amount` rows for this transaction; used in gross/net expense calculations
- `applied_date` — optional `YYYY-MM-DD` override that re-attributes the transaction to a different month for all chart and ledger bucketing; when set, `COALESCE(applied_date, date)` is used throughout

**`payment_splits`:** Divides a single payment (e.g. a lump-sum reimbursement) into date-specific portions so each portion appears in the shared ledger at its applied date. Columns: `transaction_id`, `amount`, `applied_date`, `note`. On delete cascades from transactions.

### Functions

**`get_db_connection()`**
Returns a wrapped database connection. Uses SQLite locally (no `DATABASE_URL`) or psycopg2 in production (`DATABASE_URL` set). Both return an object with identical interface; all SQL uses `%s` placeholders.

**`init_db()`**
Called once at app startup. Creates all tables with full column definitions (no incremental migrations needed for a fresh database). On SQLite, also runs `ALTER TABLE ... ADD COLUMN` guards for pre-existing databases. Resets orphaned settlements, backfills `user_id = 1` for any unscoped rows, and calls `clean_account_names()`.

PostgreSQL uses `SERIAL PRIMARY KEY`; SQLite uses `INTEGER PRIMARY KEY AUTOINCREMENT`. The correct type is selected automatically at startup.

Creates the following indexes: `idx_transaction_date (date)`, `idx_transactions_user_date (user_id, date)`, `idx_transactions_user_applied (user_id, applied_date)`, `idx_transactions_user_payment (user_id, is_payment)`, `idx_payment_splits_txn (payment_splits.transaction_id)`, `idx_transaction_shares_txn (transaction_shares.transaction_id)`, and a partial unique index on `plaid_transaction_id`.

**`get_categories(user_id=1)`**
Returns the ordered list of category names for the given user from the `categories` table.

**`insert_transactions(transactions, user_id=1)`**
Inserts a list of transaction tuples from CSV or Plaid processing. Uses `ON CONFLICT DO NOTHING` to silently skip duplicate rows. Returns the number of rows actually inserted.

**`get_monthly_summary()`**
Returns total spend and transaction count grouped by month.

**`get_category_breakdown(start_date, end_date)`**
Returns total spend grouped by user-assigned category, optionally filtered to a date range.

**`get_all_transactions(limit)`**
Returns the most recent N transactions.

**`get_detailed_summary(year, month)`**
Returns year-to-date and single-month category totals.

**`get_detailed_breakdown(year, month, user_id=1)`**
The primary data source for the Overview tab tables. Returns three maps — `month_totals`, `year_totals`, and `year_averages` — each keyed by category with both `gross` and `net` values.

- **Gross** — cash you physically paid out: `CASE WHEN payer='Me' THEN amount ELSE 0 END`
- **Net** — your true economic obligation: `CASE WHEN payer='Me' THEN (amount - reimbursement_amount) ELSE reimbursement_amount END`
- All date comparisons use `COALESCE(applied_date, date)` so date-overridden transactions land in the correct bucket.

**`get_overview_history(year, month, view_mode, time_range, user_id=1)`**
Powers the stacked bar chart. Returns a list of month labels and per-category totals for the requested range (1m/3m/6m/1y/5y) ending at the given month. Executes a single `GROUP BY month_key, category` query and pivots the result in Python. Categories are queried on the same connection to avoid a second round-trip. The date filter uses a two-branch OR (applied_date IS NOT NULL / date >= %s with a Python date object) so PostgreSQL can use the `(user_id, date)` composite index.

**`clean_account_names()`**
Normalises `card_name` values from CSV imports (e.g. collapses various Chase name strings to `"Chase"`). Run automatically at startup.

**`migrate_to_unique()`**
Historical one-time migration that added a `UNIQUE` constraint to the transactions table. No longer called; kept for reference.

</details>

---

<details>
<summary><strong>migrate_to_postgres.py</strong></summary>

One-time script to copy all data from the local `budget.db` into a PostgreSQL database. Run once after the production database has been provisioned and `init_db()` has created the schema.

```bash
DATABASE_URL=postgresql://user:pass@host/db python migrate_to_postgres.py
```

Uses the **External Database URL** from Render (the Internal URL only works from within Render's network). Migrates all tables in foreign-key dependency order, handles the SQLite bytes → PostgreSQL string conversion for `password_hash`, then resets all SERIAL sequences so new inserts get correct IDs.

Safe to re-run: uses `ON CONFLICT DO NOTHING` so existing rows are skipped. Prompts for confirmation if the destination already contains transaction data.

</details>

---

<details>
<summary><strong>plaid_integration.py</strong></summary>

Thin wrapper around the Plaid Python SDK. Flask routes in `app.py` call these functions; nothing else should import the Plaid SDK directly.

### Functions

**`_get_client()`**
Builds and returns a configured `PlaidApi` client using credentials from `.env`. Switches between Sandbox and Production environments based on `PLAID_ENV`.

**`create_link_token(user_id)`**
Requests a short-lived Link token from Plaid. The frontend passes this to the Plaid Link SDK to open the bank-connection popup.

**`exchange_public_token(public_token)`**
Exchanges the temporary `public_token` returned by Plaid Link for a permanent `access_token`. Returns `{ access_token, item_id }`.

**`fetch_transactions(access_token, start_date, account_ids, end_date=None)`**
Pulls all transactions for a connected account from `start_date` through `end_date` (defaults to today if not provided), handling Plaid's 500-transaction pagination automatically. Returns a list of dicts shaped to match the app's transactions table via `_shape_transaction`. Includes a `pending` boolean on each transaction; `transactions/get` returns pending transactions by default.

**`_shape_transaction(plaid_txn)`**
Maps a raw Plaid transaction object to the app's internal dict format. Prefers the newer `personal_finance_category` taxonomy for `bank_category`, falling back to the legacy list. Amounts follow Plaid convention: positive = debit, negative = credit. Sets `pending: True` for unsettled transactions.

</details>

---

<details>
<summary><strong>app.py</strong></summary>

The Flask application. Every URL the frontend calls is defined here. All routes require authentication via a `before_request` guard; unauthenticated requests redirect to `/login`.

A custom JSON provider (`_ISODateProvider`) is registered at startup. It serialises `datetime.date`/`datetime.datetime` values as ISO strings (Flask 3.0 defaults to HTTP date format, which breaks the frontend) and `decimal.Decimal` values as floats (Flask 3.0 defaults to strings, which breaks JavaScript arithmetic). Both cases arise when using PostgreSQL; neither occurs with SQLite since its results are already plain Python types.

### Helper Functions

**`process_csv(df, card_name, user_id)`**
Parses a pandas DataFrame from a CSV upload. Auto-detects date, description, amount, and category columns by name. Normalises amounts (expenses stored positive, payments with original sign), detects payments/credits from keywords and category values, deduplicates rows that appear more than once in the same file (appending ` (2)`, ` (3)` etc.), and calls `insert_transactions(final_data, user_id)`. Returns the number of rows inserted.

**`_filter_internal_transfers(candidates, imported_venmo_transfers=None)`**
Splits a Plaid candidate list into `(kept, removed)` based on two sets of rules:

1. **Symmetric internal transfers** — Venmo "Standard transfer" ↔ Capital One "Venmo", and Capital One "CHASE CREDIT CRD" ↔ Chase "Payment Thank You-Mobile". Both sides are removed when matched on equal-and-opposite amounts within a 5-day window.
2. **Capital One → Venmo funding transfers** — when a Capital One transaction with `bank_category = "Transfer Out Transfer Out From Apps"` matches a Venmo transaction with `bank_category = "Transfer Out Account Transfer"` by the same amount within 3 days, only the Capital One side is removed (the Venmo payment is the real expense). The Venmo side is looked up in both the new candidates list and the already-imported `imported_venmo_transfers` rows, so the Capital One transaction is suppressed even on subsequent fetches after the Venmo side is already in the database.

**`_filter_refund_pairs(candidates)`**
Splits a Plaid candidate list into `(kept, removed)` by detecting purchase/refund pairs: same description, equal-and-opposite amounts, within a 45-day window. Both sides of a matched pair are removed.

### Routes

#### Core

**`GET /`**
Renders `index.html`, injecting the current user's ordered category list as a JSON data island.

**`POST /upload`**
Accepts a CSV file and a `bank_name` form field. Delegates to `process_csv` (passing `current_user.id`) and returns the number of rows inserted.

#### Account Management

**`GET /api/account`**
Returns the current user's `email` and `display_name`.

**`PATCH /api/account/profile`**
Updates `display_name` and `email` for the current user. Returns 409 if the email is already taken.

**`PATCH /api/account/password`**
Verifies the current password and updates it to a new bcrypt hash. Enforces minimum 8-character length.

**`GET /api/account/export`**
Streams the current user's transactions as a CSV download.

**`DELETE /api/account`**
Permanently deletes the current user's account and all associated data (transactions, categories, tags, plaid accounts, etc.). Requires the user to type their email to confirm.

#### Transactions

**`GET /api/transactions`**
Returns up to N transactions (default 100, configurable via `?limit=`) for the current user, ordered newest-first, with each transaction's tags as a nested list. Includes `applied_date` in the response.

**`GET /api/transaction/<id>/details`**
Returns a single transaction by ID (scoped to current user), including its `shares` list, `payment_splits` list, and settlement count. Used to pre-populate the Edit modal.

**`POST /api/transaction/manual`**
Inserts a manually entered transaction for the current user. Accepts `is_payment`, `is_shared`, `payer`, and a `shares` list.

**`DELETE /api/transaction/<id>`**
Deletes a transaction (scoped to current user) and cascades to remove associated `transaction_shares`, `transaction_tags`, and `settlements` rows.

**`POST /api/transaction/<id>/toggle-shared`**
Flips the `is_shared` boolean on a single transaction (scoped to current user).

**`POST /api/transaction/<id>/toggle-payment`**
Flips the `is_payment` boolean, moving a transaction between Expenses and Payments (scoped to current user).

**`POST /api/transaction/bulk-edit`**
Updates one or more fields for a list of transaction IDs in one call (all scoped to current user). Accepted fields:
- `description` — updates description and merchant
- `category` — sets category and marks it as manually assigned
- `applied_date` — sets or clears the date override (key presence triggers update; `null` clears it)
- `payment_splits` — for single-transaction edits only; replaces all existing splits with `{ date, amount, note }` objects
- `is_shared` / `payer` / `shares` — fully replaces `transaction_shares`, re-links any existing settlements to the new share IDs, and updates `reimbursement_amount`

#### Overview & Summary

**`GET /api/summary`**
Returns the raw monthly summary.

**`GET /api/detailed-summary`**
Returns month totals, year totals, and year averages for the Overview tab. Accepts `?year=` and `?month=`.

**`GET /api/overview-history`**
Returns stacked bar chart data. Accepts `?year=`, `?month=`, `?view_mode=` (gross/net), and `?time_range=` (1m/3m/6m/1y/5y).

**`GET /api/account-breakdown`**
Returns total spending grouped by `card_name` (account) for the selected month. Respects gross/net view mode. Used to populate the Spending by Account panel on the Overview tab.

**`GET /api/sankey-data`**
Returns income and per-category expense totals for the Sankey (Income Flow) diagram. Accepts `?year=`, `?month=`, `?view_mode=`, and `?time_range=`.

Income calculation uses a single UNION ALL query: unsplit payments (via LEFT JOIN anti-join replacing the original correlated NOT EXISTS) combined with payment_splits rows. Expense categories are fetched in one query and partitioned into tracked vs. uncategorized in Python, replacing two separate queries. Total: 3 queries down from 5.

- Unsplit payments: LEFT JOIN on `payment_splits` with NULL check (replaces correlated `NOT EXISTS`)
- Split payments: each `payment_splits` row bucketed by its own `applied_date`

Expense calculation uses the same gross/net formula as `get_detailed_breakdown`.

#### Categories

**`GET /api/categories`**
Returns the current user's ordered list of category names.

**`POST /api/categories`**
Adds a new category for the current user. Body: `{ name }`. Returns 409 if the name already exists.

**`PATCH /api/categories/<name>`**
Renames a category and auto-migrates all of the user's transactions with that category to the new name.

**`DELETE /api/categories/<name>`**
Deletes a category. Returns 409 with `{ confirm_required, count }` if transactions exist; pass `?confirm=1` to force delete.

**`POST /api/categories/reorder`**
Saves a new display order. Body: `{ order: [name, name, ...] }`.

#### Shared Expenses & Ledger

**`GET /api/shared-ledger`**
Returns the full shared-expense ledger for the current user. Query params: `?person=`, `?year=`, `?month=`.

Logic:
1. Fetches all shared transactions where you are the payer or a share recipient
2. Payments with `payment_splits` are expanded into one row per split (each at its own `applied_date`)
3. Rows sorted by effective date ascending; `net_balance` (all-time cumulative) computed before any filter
4. Year/month filter applied to produce `display_rows` with their own running balance starting from 0
5. Returns `net_balance` (all-time), `month_net` (filtered-period net), and `is_filtered` flag

Also returns all known people grouped into `owes_me`, `i_owe`, and `settled` for the dropdown.

Balance sign convention: positive = others owe you; negative = you owe others.

**`GET /api/people`**
Returns a deduplicated list of all person names that appear as payers or share recipients for the current user.

#### Tags

**`GET|POST /api/tags`**
Lists all tags for the current user (GET), optionally filtered to tags used in a specific category (`?category=`), or attaches a tag to a list of transaction IDs (POST), creating the tag if it doesn't exist.

**`DELETE /api/tag/<id>`**
Globally deletes a tag (scoped to current user) and removes it from all transactions and tag defaults.

**`DELETE /api/transaction/<id>/tag/<tag_id>`**
Removes a single tag from a single transaction without affecting the tag globally.

**`GET|POST /api/tag-defaults`**
Gets or sets the default tags for a given category for the current user.

#### Detailed Breakdowns

**`GET /api/breakdown-report`**
Returns chart data (monthly totals) and table data (individual transactions) for the selected category, tags, year/month, view mode, and time range. When `category` is omitted, returns results across all categories and includes a `category` column in the table rows. Scoped to current user.

**`GET|POST /api/breakdown-views`**
Lists all saved breakdown views for the current user (GET) or creates/updates one by name (POST). Each view stores a name, category, tag ID list, view mode, and time range.

**`DELETE /api/breakdown-views/<id>`**
Deletes a saved breakdown view (scoped to current user).

#### Plaid Integration

**`POST /api/plaid/link-token`**
Returns a Plaid Link token so the frontend can open the bank-connection popup.

**`POST /api/plaid/exchange-token`**
Exchanges a temporary public token for a permanent access token and upserts the account in `plaid_accounts` (`ON CONFLICT(item_id) DO UPDATE`).

**`GET /api/plaid/accounts`**
Returns all connected Plaid accounts for the current user (access tokens not exposed).

**`DELETE|PATCH /api/plaid/accounts/<id>`**
Disconnects a Plaid account (DELETE) or renames its display name (PATCH), scoped to current user.

**`POST /api/plaid/fetch-transactions`**
Fetches candidate transactions from all connected accounts within a date window (`since_date` to `end_date`; `end_date` defaults to today if omitted), deduplicates against already-imported rows (by Plaid transaction ID), and filters out internal transfers (`_filter_internal_transfers`) and purchase/refund pairs (`_filter_refund_pairs`). Returns `{ candidates, filtered_out }`.

**`POST /api/plaid/lookup-profiles`**
Given a list of transaction descriptions, returns the existing category and tag profile for each: `unique`, `conflict`, or `none`. Used during import to auto-apply or prompt for resolution. Uses `STRING_AGG` (PostgreSQL) to aggregate tag names per transaction.

**`POST /api/plaid/lookup-shared-profiles`**
Given a list of transaction descriptions, returns the most recent shared-expense split profile for each. Used during import to pre-fill split configuration for recurring shared transactions.

**`POST /api/plaid/import-transactions`**
Inserts selected transactions for the current user. For each transaction:
1. Checks whether an existing CSV-imported row (no Plaid ID) matches on date/description/amount/card_name and backfills the Plaid ID onto it
2. If no match, inserts a new row via `INSERT ... ON CONFLICT DO NOTHING`
3. If the insert is silently ignored (Plaid changed the transaction ID after the fact, e.g. pending → posted), the existing row is updated to adopt the new Plaid ID so it stops resurfacing as a candidate

Also applies resolved tags and shared split data.

</details>

---

<details>
<summary><strong>templates/index.html</strong></summary>

The single HTML page (requires authentication). All tabs, tables, modals, and controls are defined here as static markup; `main.js` populates and drives them at runtime.

**Tabs:** Overview · Import · Transactions · Shared Expenses · Detailed Breakdowns

**Overview tab:**
- **Monthly Spending Trend** — stacked bar chart and **Income Flow** — Sankey diagram, switchable via dot navigation
- **Spending by Account** — bar rows showing spend per card/account for the selected month
- **Monthly / Yearly / Average toggle** — single table that switches between the three views; Monthly view includes a month-over-month delta badge (↑/↓ %) on each category row
- Gross/Net toggle and time-range buttons (1M/3M/6M/1Y/5Y) apply globally to charts, tables, and the account breakdown

**Transactions tab:**
- Expenses table and Payments table with shared filters (text search, category, bank category, account, shared status, tag, year, month)
- Edit modal supports: description, category, applied date override, payment splits (for payment transactions), shared status, payer, and per-person share amounts
- Add Transaction modal for manual entries

**Shared Expenses tab:**
- Person filter dropdown (grouped into Owes You / You Owe / Settled Up) and year/month filter with a Clear button
- Unified ledger table showing running balance with period net shown in the filter bar when a year/month is selected
- Transactions with payment splits appear as one row per split at the split's applied date

**Detailed Breakdowns tab:**
- Category dropdown with an "All Categories" option (shows cross-category results with a category badge per row)
- Tag selection with tag defaults and a Saved Views panel; tags shown are scoped to the selected category
- History chart (line) and transaction table for the selected filters
- Comparison mode: toggle multiple saved views to overlay them as color-coded lines on the same chart

**Import tab:**
- CSV upload with bank name selector
- Plaid bank connection (connect, rename, disconnect)
- Date range picker (start + end) for controlling the fetch window. Start defaults to the 1st of the current month, or 30 days ago if today is within the first 15 days of the month. End defaults to today.
- Candidate transaction table with a **Status** column (Pending / Settled badge); pending rows are greyed out with their checkbox disabled to prevent importing unsettled transactions. Defaults to no rows selected.
- Filtered Out table showing automatically suppressed internal transfers and refund pairs, with per-row Restore buttons

**Settings modal (gear icon, top-right):**

*Account tab:*
- Profile section — edit display name and email
- Change Password section — verify current password, set new one (min 8 characters)
- Export Data — download all transactions as CSV
- Session — Log Out button
- Close Account (danger zone) — permanently deletes all data; requires email confirmation

*Categories tab:*
- Drag-to-reorder list of the user's spending categories
- Inline rename (click to edit)
- Delete (warns if transactions exist, requires confirmation)
- Add new category input

**Data island:** Injects the current user's ordered category list as `<script type="application/json">` so `main.js` never needs a separate API call on initial load.

</details>

---

<details>
<summary><strong>templates/login.html</strong></summary>

Standalone login page served before the app shell. Displays a centred card with email and password fields. Flash messages (e.g. "Invalid email or password") appear inline above the form. Uses the same dark-theme CSS variables as the main app.

</details>

---

<details>
<summary><strong>static/js/main.js</strong></summary>

All client-side logic. Drives every tab, modal, chart, and data fetch.

### Globals

- `currentViewMode` — `'gross'` or `'net'` (default `'net'`); controls which expense formula is used across all charts and tables
- `overviewChartRange` — active time range for the Overview chart (`'1m'` / `'3m'` / `'6m'` / `'1y'` / `'5y'`)
- `overviewSlide` — 0 = bar chart, 1 = Sankey
- `_overviewTableMode` — `'monthly'` / `'yearly'` / `'average'`; which Overview table is currently shown
- `_overviewTableData` — cached `{ month_totals, year_totals, year_averages }` from the last `/api/detailed-summary` call
- `_overviewHistory` — cached result from the last `/api/overview-history` call; used to compute month-over-month deltas
- `allTransactions` — cached full transaction list used for client-side filtering
- `TRACKED_CATEGORIES` — parsed from the page's JSON data island; updated in-place after every category mutation

### Initialisation

**`setupCategoryDropdowns()`**
Populates every `<select>` that lists user-assignable categories.

**`setupYearDropdown()`**
Populates year `<select>` elements from 2026 to the current year.

**`updateMonthDropdown()` / `updateBreakdownMonthDropdown()` / `updateMonthDropdownGeneric(yearId, monthId)`**
Rebuilds a month dropdown for the selected year, capping at the current month when the current year is selected.

### Utilities

**`formatDate(dateStr)`**
Converts `YYYY-MM-DD` to "Mon D, YYYY" using local time (avoids UTC off-by-one).

**`formatMonth(monthStr)`**
Converts `YYYY-MM` to "Month YYYY".

**`fmtAppliedDate(d)`**
Formats an applied-date string for display in transaction rows; returns empty string if null.

**`getAccountClass(accountName)`**
Returns a CSS class for an account badge (Chase, Capital One, Venmo, or generic fallback).

**`renderTxnTags(txn)`**
Returns the HTML for a transaction's tag pills with inline × remove buttons.

**`showStatus(message, type)`**
Displays a success or error banner that auto-hides after 5 seconds.

### Settings Modal

**`openSettingsModal()` / `closeSettingsModal()`**
Opens or closes the Settings modal and loads account data on open.

**`switchSettingsTab(tab)`**
Switches between the Account and Categories panels and updates tab button styles.

**`loadAccountData()`**
Fetches `/api/account` and pre-fills the profile fields.

**`saveProfile()` / `changePassword()`**
PATCH `/api/account/profile` and `/api/account/password` respectively; display inline status messages.

**`exportData()`**
Navigates to `/api/account/export` to trigger a CSV download.

**`closeAccount()`**
Sends a DELETE to `/api/account` with the email confirmation value; reloads the page on success.

**`loadCategorySettings()`**
Fetches the current category list and renders a sortable, editable list in the Categories panel.

**`addCategory()` / `renameCategory(oldName, newName)` / `deleteCategory(name)` / `reorderCategories()`**
CRUD operations on `/api/categories`; each refreshes the category list and updates `TRACKED_CATEGORIES`.

### Overview Tab

**`loadSummary()`**
Two-phase load: Phase 1 awaits `loadCurrentOverviewChart()` alone so the bar chart (the first thing the user sees) gets exclusive server access. Phase 2 fires `detailed-summary`, `loadOverviewInsights()`, and `loadAccountBreakdown()` in parallel while the user reads the chart — the 5-year insights query no longer competes with the chart fetch.

**`switchOverviewTable(mode)`**
Sets `_overviewTableMode` to `'monthly'`, `'yearly'`, or `'average'`, updates the toggle button styles, and calls `renderActiveOverviewTable()`.

**`renderActiveOverviewTable()`**
Reads `_overviewTableMode` and renders the appropriate data from `_overviewTableData` into the single Overview table.

**`updateOverviewTable(tableId, dataMap)`**
Renders a category-by-amount table using the current gross/net view mode. In monthly mode, appends a month-over-month delta badge (↑/↓ %) for each category row using `_overviewHistory` if available.

**`loadOverviewInsights()`**
Fetches `/api/overview-history`, stores the result in `_overviewHistory`, and computes contextual insight panels (trend, year-over-year, typical spend) for each of the three table modes.

**`loadAccountBreakdown()`**
Fetches `/api/account-breakdown` and renders per-account spending bars into the Spending by Account panel.

**`setOverviewSlide(index)`**
Switches the Overview chart panel between the bar chart (slide 0) and Sankey (slide 1).

**`loadCurrentOverviewChart()`**
Calls `loadOverviewHistoryChart()` or `loadSankeyChart()` depending on the active slide.

**`loadOverviewHistoryChart()`**
Fetches monthly category data and renders a Plotly stacked bar chart with per-month total labels and a dashed average line.

**`_prefetchSankeyData()`**
Starts the `/api/sankey-data` fetch immediately and stores the Promise in `_sankeyPromise` keyed by the current params string. Called from `loadSummary()` so the Sankey data is in-flight (or already resolved) before the user navigates to slide 1.

**`loadSankeyChart()`**
Fetches income and expense data and renders a Plotly Sankey diagram. Uses `arrangement: 'fixed'` with manual node coordinates to pin Savings at the bottom-right, separated from expense categories. Reuses the in-flight or resolved `_sankeyPromise` if params match, so navigating to slide 1 after the initial overview load renders immediately rather than waiting for a new fetch.

**`setOverviewChartRange(event, range)`**
Updates the active time-range button and reloads the current Overview chart.

**`setViewMode(mode)`**
Switches `currentViewMode` between gross and net and refreshes the Overview tab including the account breakdown.

### Transactions Tab

**`loadFullTransactions()`**
Fetches all transactions (up to 1,000), caches them in `allTransactions`, rebuilds filter dropdowns, and calls `filterTransactions`.

**`filterTransactions()`**
Applies all active filters client-side and passes results to `renderFilteredTable`. Computes and shows expense/payment totals when any filter is active.

**`renderFilteredTable(data)`**
Splits filtered transactions into expenses and payments and renders each into its respective table with checkboxes, tags, shared indicators, and an orange applied-date badge when `applied_date` is set.

**`updateBankCategoryDropdown()` / `updateBankNameDropdown()`**
Rebuild filter dropdowns from the current `allTransactions` list.

**`deleteTransaction(txnId)`**
Confirms (escalating warning if settlements exist), deletes, and refreshes transactions and overview data.

**`bulkDelete()`**
Deletes all checked transactions after a confirmation prompt.

**`bulkTogglePayment()`**
Moves all checked transactions between Expenses and Payments.

**`toggleAll(type)`**
Checks or unchecks all rows in the Expenses or Payments table.

**`openEditModal()` / `closeEditModal()` / `submitEdit()`**
Opens the Edit modal, pre-populating it when exactly one transaction is selected. For single-transaction edits includes applied date and payment splits fields. Submits via `/api/transaction/bulk-edit`. Stores the current transaction amount in `_currentEditAmount` so the payment amount field pre-fills correctly when switching to Shared mode.

**`openAddModal()` / `closeAddModal()` / `submitAdd()`**
Opens the Add Transaction modal and submits to `/api/transaction/manual`.

**`toggleEditSharedFields()` / `toggleAddSharedFields()`**
Shows or hides the payer and share rows in the Edit and Add modals.

**`updateSharedSentence(prefix)`**
Updates the "who paid / who owes" label and shows/hides the split-row container based on the current payer and transaction type. Pre-fills the payment amount from `_currentEditAmount` if the field is empty.

**`addShareRow(containerId, name, amount)`**
Appends a person + amount row to the split container in the Edit or Add modal.

**`addSplitRow(date, amount, note)`**
Appends a payment-split row (date + amount + note) to the Payment Splits section in the Edit modal.

**`removeSplitRow(btn)` / `updateSplitTotal()`**
Removes a split row and keeps the running total display updated.

**`setupModalDropdowns(isPaymentEdit)`**
Rebuilds payer and category dropdowns inside the Edit modal for the appropriate transaction type.

### Shared Ledger Tab

**`_apiCache`** (Map)
URL-keyed promise cache. `_cachedFetch(url)` stores the fetch+JSON Promise on first call and returns the same Promise on every repeat, making view-mode toggles and repeated chart renders instant. Cleared via `loadSummary(true)` after any data mutation.

**`_prefetchSharedLedger()`**
Fires the default (no filters) `/api/shared-ledger` request on page load and stores the Promise in `_sharedLedgerPromise`. Mirrors the Sankey prefetch pattern.

**`loadSharedLedger()`**
Fetches the shared ledger with optional person/year/month filters and renders the unified transaction list and running balance. Reuses the in-flight or resolved `_sharedLedgerPromise` when params match the prefetch key. When a year/month filter is active, shows the period net in the filter bar.

**`clearSharedFilters()`**
Resets year and month selects to "All" and reloads the ledger.

**`refreshSavedPeople()`**
Re-fetches all known people from `/api/people` and stores them in `savedPeople` for use in payer and share dropdowns throughout the app.

### Tag Modal

**`openTagModal()` / `closeTagModal()` / `submitTags()`**
Opens the tag assignment modal for checked transactions, manages the staged tag set, and submits to `/api/tags`.

**`stageNewTag()`**
Adds a typed tag name to the staged set without submitting.

**`_escJs(s)`**
Escapes backslashes and single quotes in a string for safe embedding in an inline `onclick` attribute. Applied to all tag names passed to onclick handlers so tags with apostrophes (e.g. "Liar's Bench") don't break the JavaScript string.

**`renderStagedTags()` / `renderExistingTags(tags)`**
Re-renders staged tag pills and the existing tag grid in the modal. Tag names are passed through `_escJs()` before being embedded in onclick attributes.

**`toggleStagedTag(name, id)` / `removeStagedTag(name)`**
Adds or removes a tag from the staged set.

**`deleteTagGlobal(tagId, tagName)`**
Globally deletes a tag and refreshes all affected UI.

**`removeTag(txnId, tagId)`**
Removes a single tag from a single transaction via the inline × button.

### Detailed Breakdowns Tab

**`loadBreakdownView()`**
Initialises year/month dropdowns, rebuilds the tag checklist (scoped to the selected category), clears comparison selection, loads tag defaults, and fetches saved views.

**`loadBreakdownData()`**
Fetches chart and table data for the current filters. Delegates to `loadComparisonData()` when comparison views are active.

**`setBreakdownViewMode(mode)`**
Switches between gross and net and reloads.

**`setBreakdownChartRange(event, range)`**
Updates the active time-range button and reloads.

**`loadTagDefaults()` / `saveTagDefaults()`**
Loads or saves the default tag selection for the current category via `/api/tag-defaults`.

**`deselectAllTags()`**
Unchecks all tag checkboxes and reloads.

### Saved Views & Comparison Mode

**`loadSavedViews()`**
Fetches all saved views and calls `renderSavedViews`.

**`renderSavedViews()`**
Filters to the current category and renders each view as a clickable row. Active comparison views shown with a color dot and border.

**`toggleComparisonView(viewId)`**
Adds or removes a view from the `activeComparisonViews` map, assigning a color from `COMPARISON_COLORS`.

**`saveCurrentBreakdownView()`**
Prompts for a name and saves the current category and tag selection to `/api/breakdown-views`. Overwrites any existing view with the same name.

**`deleteSavedView(id)`**
Removes a view from the comparison set, deletes it from the database, and refreshes the panel.

**`loadComparisonData()`**
Fetches breakdown data for all active comparison views in parallel, then calls `renderComparisonChart` and `renderComparisonTable`.

**`renderComparisonChart(results)`**
Plots one colored Plotly line trace per active view.

**`renderComparisonTable(results)`**
Merges all transactions from active views, sorts by date descending, groups by month, and renders each row with a left-border color matching its chart line.

### Plaid Import Tab

**`initPlaidLink()`**
Fetches a Link token and initialises the Plaid Link handler. Called on page load and after each successful connection.

**`openPlaidLink()`**
Opens the Plaid Link popup.

**`loadPlaidAccounts()`**
Fetches connected accounts and renders them with Rename and Disconnect controls.

**`renamePlaidAccount(id, currentName)` / `disconnectPlaidAccount(id, name)`**
PATCH or DELETE a connected account.

**`fetchPlaidCandidates()`**
Fetches candidates from `/api/plaid/fetch-transactions`, stores them in `plaidCandidates` and `plaidFilteredOut`, then renders both tables.

**`renderPlaidCandidates()`**
Renders the candidate transaction table. Pending transactions are shown with a "Pending" badge, greyed out, and their checkbox disabled. All checkboxes default to unchecked.

**`plaidSelectAll(checked)`**
Checks or unchecks all non-disabled candidate checkboxes.

**`moveToFiltered()`**
Moves all checked candidate rows into `plaidFilteredOut` and re-renders both tables.

**`moveBackToImportable(plaidId)`**
Moves a single transaction from `plaidFilteredOut` back into `plaidCandidates` and re-renders.

**`renderFilteredOutTable()`**
Renders the Filtered Out section. Hidden when empty. Each row has a Restore button.

**`importSelectedPlaidTransactions()`**
Full import flow for checked candidates:
1. Looks up existing category/tag profiles per unique description
2. Looks up existing shared-split profiles per unique description
3. Shows conflict-resolution modal for descriptions with inconsistent history
4. Shows split-configuration modal for descriptions with prior shared history
5. Enriches each transaction and posts the batch to `/api/plaid/import-transactions`

**`showSharedSplitModal(description, amount, profile)` / `resolveSharedSplit(apply)` / `addSplitPersonRow(name, amount)`**
Manages the split-configuration modal during import. Pre-fills from history, scales amounts if the total changed, and resolves to a shares array or `null`.

**`showConflictModal(description, options)` / `resolveConflict(choice)`**
Manages the category-conflict modal. Presents options as radio buttons and resolves to `{ category, tags }` or `null`.

</details>

---

## Environment Variables

Create a `.env` file in the project root for local development:

```
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_secret
PLAID_ENV=sandbox        # or 'production' once Plaid approves your app
SECRET_KEY=a_long_random_string
# DATABASE_URL is not set locally — the app uses SQLite (budget.db) automatically
```

In production (Render), set these as environment variables in the dashboard:

```
SECRET_KEY=...           # generate: python -c "import secrets; print(secrets.token_hex(32))"
DATABASE_URL=...         # auto-provided by Render when you link a PostgreSQL database
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=sandbox        # change to 'production' after Plaid approves your application
```

When `DATABASE_URL` is set, the app uses PostgreSQL. When it is not set, the app uses SQLite. No code changes required between environments.

---

## Running Locally

```bash
pip install -r requirements.txt
python app.py
```

The app starts on `http://localhost:5000`. On first run `init_db()` creates `budget.db` automatically.

### Adding Users

There is no self-registration. Create accounts with the CLI script:

```bash
python create_user.py
```

Prompts for email and password. Run once per user you want to invite.

---

## Deployment (Render)

1. **Push to GitHub** — make sure `.env` is in `.gitignore` (it already is)
2. **Create a PostgreSQL database** on Render (New → PostgreSQL). Copy the External and Internal connection URLs.
3. **Create a Web Service** on Render (New → Web Service). Connect your GitHub repo and set:
   - Build command: `pip install -r requirements.txt`
   - Start command: `gunicorn app:app --bind 0.0.0.0:$PORT --worker-class gthread --threads 4`
   - Add environment variables: `SECRET_KEY`, `DATABASE_URL` (Internal URL), `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`
4. **First deploy** — `init_db()` runs at startup and creates all tables in PostgreSQL automatically.
5. **Migrate existing data** — from your local machine, run:
   ```bash
   DATABASE_URL="<External URL>" python migrate_to_postgres.py
   ```
6. **Create users** — use the Shell tab in the Render dashboard to run `python create_user.py` for any new users. Your existing account was migrated in step 5.

### Plaid in production

Plaid sandbox mode shows fake test data. To connect real bank accounts, apply for production access at [dashboard.plaid.com](https://dashboard.plaid.com). Once approved, change `PLAID_ENV` to `production` and update `PLAID_SECRET` to your production secret in the Render environment variables (`PLAID_CLIENT_ID` stays the same across environments). Personal-use "Pay as you go" production access supports up to 100 free Items (bank connections) per month.
