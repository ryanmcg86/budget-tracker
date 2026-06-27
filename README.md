# Spending Tracker

A personal finance web app built with Flask and SQLite. Transactions can be imported via CSV upload or fetched live from connected bank accounts through the Plaid API. The app tracks spending by category, handles shared expenses and bill splitting across multiple people, and provides detailed breakdowns with tagging and saved views.

---

## Project Structure

```
spending-tracker/
├── app.py                  # Flask application — all API routes
├── database.py             # Database schema, migrations, and query helpers
├── plaid_integration.py    # Plaid API client (link tokens, token exchange, transaction fetch)
├── static/js/main.js       # All frontend logic (vanilla JS + Plotly)
├── static/css/style.css    # Dark-theme stylesheet
├── templates/index.html    # Single-page HTML shell
└── budget.db               # SQLite database (auto-created on first run)
```

---

## Scripts

<details>
<summary><strong>database.py</strong></summary>

Owns the database layer. All other files import from here rather than opening `budget.db` directly.

### Constants

**`TRACKED_CATEGORIES`**
The canonical list of ten spending categories used throughout the app (Streaming, Transportation, Food/Drink, Travel, Utilities, Party, Wellness, Entertainment, Investing, Miscellaneous/Infrequent). Injected into `index.html` at render time so the frontend and backend always share the same list. Adding or removing a category here must be mirrored on the frontend.

### Database Schema

| Table | Purpose |
|---|---|
| `transactions` | Core transaction ledger |
| `payment_splits` | Sub-rows that divide a lump payment across multiple applied dates |
| `transaction_shares` | Per-person share amounts for a shared transaction |
| `settlements` | Records when a shared-expense payment is matched against an expense (legacy) |
| `categories` | Category name registry (informational) |
| `tags` | Tag name registry |
| `transaction_tags` | Many-to-many link between transactions and tags |
| `tag_defaults` | Default tags to apply per category on the Detailed Breakdowns page |
| `plaid_accounts` | Connected bank accounts (stores Plaid access tokens) |
| `breakdown_views` | Saved tag+category combinations for the Detailed Breakdowns page |

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
Opens and returns a connection to `budget.db` with `row_factory = sqlite3.Row` so query results are accessible by column name.

**`init_db()`**
Called once at app startup. Creates all tables if they don't exist and runs all incremental column migrations (via try/except `ALTER TABLE`) for databases created by older versions. Also runs orphan-settlement cleanup on every startup. Calls `clean_account_names()` at the end.

**`insert_transactions(transactions)`**
Bulk-inserts a list of transaction tuples from CSV or Plaid processing. Uses `INSERT OR IGNORE` to silently skip duplicate rows (same date/description/amount/card_name). Returns the number of rows actually inserted.

**`get_monthly_summary()`**
Returns total spend and transaction count grouped by month. Mostly superseded by `get_detailed_breakdown`.

**`get_category_breakdown(start_date, end_date)`**
Returns total spend grouped by user-assigned category, optionally filtered to a date range.

**`get_all_transactions(limit)`**
Returns the most recent N transactions. Superseded in the API layer by the inline query in `/api/transactions` which also joins tags.

**`get_detailed_summary(year, month)`**
Returns year-to-date and single-month category totals. Legacy helper; the active route uses `get_detailed_breakdown` instead.

**`get_detailed_breakdown(year, month)`**
The primary data source for the Overview tab tables. Returns three maps — `month_totals`, `year_totals`, and `year_averages` — each keyed by category with both `gross` and `net` values.

- **Gross** — cash you physically paid out: `CASE WHEN payer='Me' THEN amount ELSE 0 END`. Expenses where someone else paid are excluded because that cash hasn't left your account yet.
- **Net** — your true economic obligation: `CASE WHEN payer='Me' THEN (amount - reimbursement_amount) ELSE reimbursement_amount END`. Includes your share of expenses others paid, excludes the portions others owe you.
- All date comparisons use `COALESCE(applied_date, date)` so date-overridden transactions land in the correct bucket.

**`get_overview_history(year, month, view_mode, time_range)`**
Powers the stacked bar chart. Returns a list of month labels and per-category totals for the requested range (1m/3m/6m/1y/5y) ending at the given month. Applies the same gross/net formula as `get_detailed_breakdown`.

**`clean_account_names()`**
Normalises `card_name` values from CSV imports (e.g. collapses various Chase name strings to `"Chase"`). Run automatically at startup.

**`migrate_to_unique()`**
Historical one-time migration that added a `UNIQUE` constraint to the transactions table. No longer called; kept for reference.

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

**`fetch_transactions(access_token, start_date, account_ids)`**
Pulls all transactions for a connected account from `start_date` through today, handling Plaid's 500-transaction pagination automatically. Returns a list of dicts shaped to match the app's transactions table via `_shape_transaction`.

**`_shape_transaction(plaid_txn)`**
Maps a raw Plaid transaction object to the app's internal dict format. Prefers the newer `personal_finance_category` taxonomy for `bank_category`, falling back to the legacy list. Amounts follow Plaid convention: positive = debit, negative = credit.

</details>

---

<details>
<summary><strong>app.py</strong></summary>

The Flask application. Every URL the frontend calls is defined here. Helper functions that don't serve a route live at the top of the Plaid section.

### Helper Functions

**`process_csv(df, card_name)`**
Parses a pandas DataFrame from a CSV upload. Auto-detects date, description, amount, and category columns by name. Normalises amounts (expenses stored positive, payments with original sign), detects payments/credits from keywords and category values, deduplicates rows that appear more than once in the same file (appending ` (2)`, ` (3)` etc.), and calls `insert_transactions`. Returns the number of rows inserted.

**`_filter_internal_transfers(candidates)`**
Splits a Plaid candidate list into `(kept, removed)` based on known internal transfer pairs defined in `TRANSFER_PAIRS` — currently: Venmo "Standard transfer" ↔ Capital One "Venmo", and Capital One "CHASE CREDIT CRD" ↔ Chase "Payment Thank You-Mobile". Pairs are matched on equal-and-opposite amounts within a 5-day window. Returns a tuple so the frontend can show both lists.

### Routes

#### Core

**`GET /`**
Renders `index.html`, injecting `TRACKED_CATEGORIES` as a JSON data island.

**`POST /upload`**
Accepts a CSV file and a `bank_name` form field. Delegates to `process_csv` and returns the number of rows inserted.

#### Transactions

**`GET /api/transactions`**
Returns up to N transactions (default 100, configurable via `?limit=`) ordered newest-first, with each transaction's tags as a nested list. Includes `applied_date` in the response.

**`GET /api/transaction/<id>/details`**
Returns a single transaction by ID, including its `shares` list (from `transaction_shares`), `payment_splits` list, and settlement count. Used to pre-populate the Edit modal.

**`POST /api/transaction/manual`**
Inserts a manually entered transaction. Accepts `is_payment`, `is_shared`, `payer`, and a `shares` list.

**`DELETE /api/transaction/<id>`**
Deletes a transaction and cascades to remove associated `transaction_shares` and `settlements` rows.

**`POST /api/transaction/<id>/toggle-shared`**
Flips the `is_shared` boolean on a single transaction.

**`POST /api/transaction/<id>/toggle-payment`**
Flips the `is_payment` boolean, moving a transaction between the Expenses and Payments tables.

**`POST /api/transaction/bulk-edit`**
Updates one or more fields for a list of transaction IDs in one call. Accepted fields:
- `description` — updates description and merchant
- `category` — sets category and marks it as manually assigned
- `applied_date` — sets or clears the date override (key presence triggers update; `null` clears it)
- `payment_splits` — for single-transaction edits only; replaces all existing splits for that transaction with the provided list of `{ date, amount, note }` objects
- `is_shared` / `payer` / `shares` — fully replaces `transaction_shares`, re-links any existing settlements to the new share IDs, and updates `reimbursement_amount`

#### Overview & Summary

**`GET /api/summary`**
Returns the raw monthly summary from `get_monthly_summary()`.

**`GET /api/detailed-summary`**
Returns month totals, year totals, and year averages for the Overview tab from `get_detailed_breakdown`. Accepts `?year=` and `?month=`.

**`GET /api/overview-history`**
Returns stacked bar chart data. Accepts `?year=`, `?month=`, `?view_mode=` (gross/net), and `?time_range=` (1m/3m/6m/1y/5y). Applies the same gross/net formula as `get_detailed_breakdown`.

**`GET /api/sankey-data`**
Returns income and per-category expense totals for the Sankey (Income Flow) diagram. Accepts `?year=`, `?month=`, `?view_mode=`, and `?time_range=`.

Income calculation:
- Unsplit payments: `COALESCE(applied_date, date)` used for date bucketing; gross includes shared payments, net excludes them (`AND is_shared = 0`)
- Split payments: each `payment_splits` row is bucketed by its own `applied_date`

Expense calculation uses the same gross/net formula as `get_detailed_breakdown`:
- **Gross** — `CASE WHEN payer='Me' THEN amount ELSE 0 END`
- **Net** — `CASE WHEN payer='Me' THEN (amount - reimbursement_amount) ELSE reimbursement_amount END`

This means gross/net savings differ by exactly the net shared balance still outstanding: `gross_savings − net_savings = shared_income_received − net_fronted_for_others`.

#### Categories & Rules

**`GET /api/categories`**
Returns total spend grouped by category.

**`GET|POST /api/rules`**
Lists all category rules (GET) or creates a new one and immediately re-applies all rules to existing transactions (POST).

**`DELETE /api/rules/<id>`**
Deletes a single category rule.

#### Shared Expenses & Ledger

**`GET /api/shared-ledger`**
Returns the full shared-expense ledger. Query params: `?person=` (filter to one person), `?year=`, `?month=`.

Logic:
1. Fetches all shared transactions where you are the payer or a share recipient
2. Payments with `payment_splits` are expanded into one row per split (each at its own `applied_date`)
3. Rows are sorted by effective date ascending
4. `net_balance` (all-time cumulative) is computed across all rows before any filter is applied
5. Year/month filter is then applied to produce `display_rows`; those rows get their own running balance starting from 0
6. Returns `net_balance` (all-time), `month_net` (filtered-period net), and `is_filtered` flag

Also returns all known people grouped into `owes_me`, `i_owe`, and `settled` for the dropdown, with their all-time balances.

Balance sign convention: positive = others owe you; negative = you owe others.

**`GET /api/people`**
Returns a deduplicated list of all person names that appear as payers or share recipients.

#### Tags

**`GET|POST /api/tags`**
Lists all tags (GET) or attaches one or more tag names to a list of transaction IDs (POST), creating new tags as needed.

**`DELETE /api/tag/<id>`**
Globally deletes a tag and removes it from all transactions and tag defaults.

**`DELETE /api/transaction/<id>/tag/<tag_id>`**
Removes a single tag from a single transaction without affecting the tag globally.

**`GET|POST /api/tag-defaults`**
Gets or sets the default tags for a given category on the Detailed Breakdowns page.

#### Detailed Breakdowns

**`GET /api/breakdown-report`**
Returns chart data (monthly totals) and table data (individual transactions) for the selected category, tags, year/month, view mode, and time range. Table covers the full time range shown on the graph, not just the selected month.

**`GET|POST /api/breakdown-views`**
Lists all saved breakdown views (GET) or creates/updates one by name (POST). Each view stores a name, category, tag ID list, view mode, and time range.

**`DELETE /api/breakdown-views/<id>`**
Deletes a saved breakdown view.

#### Plaid Integration

**`POST /api/plaid/link-token`**
Returns a Plaid Link token so the frontend can open the bank-connection popup.

**`POST /api/plaid/exchange-token`**
Exchanges a temporary public token for a permanent access token and stores the account in `plaid_accounts`.

**`GET /api/plaid/accounts`**
Returns all connected Plaid accounts (access tokens not exposed).

**`DELETE|PATCH /api/plaid/accounts/<id>`**
Disconnects a Plaid account (DELETE) or renames its display name (PATCH).

**`POST /api/plaid/fetch-transactions`**
Fetches candidate transactions from all connected accounts since a given date, deduplicates against already-imported rows (by Plaid transaction ID), and filters out internal transfers via `_filter_internal_transfers`. Returns `{ candidates, filtered_out }`.

**`POST /api/plaid/lookup-profiles`**
Given a list of transaction descriptions, returns the existing category and tag profile for each: `unique` (all history consistent), `conflict` (history differs), or `none` (never seen). Used during import to auto-apply or prompt for resolution.

**`POST /api/plaid/lookup-shared-profiles`**
Given a list of transaction descriptions, returns the most recent shared-expense split profile for each (who owes what). Used during import to pre-fill split configuration for recurring shared transactions.

**`POST /api/plaid/import-transactions`**
Inserts selected transactions. For each: first checks whether an existing CSV-imported row (no Plaid ID) matches on date/description/amount/card_name and backfills the Plaid transaction ID onto it. If no such row exists, inserts a new row via `INSERT OR IGNORE`. If the insert is silently ignored due to the UNIQUE constraint on (date, description, amount, card_name) — which happens when Plaid changes a transaction's ID after the fact (e.g. pending → posted) — the existing row is updated to adopt the new Plaid ID so it stops resurfacing as a candidate. Also applies resolved tags and shared split data.

</details>

---

<details>
<summary><strong>templates/index.html</strong></summary>

The single HTML page. All tabs, tables, modals, and controls are defined here as static markup; `main.js` populates and drives them at runtime.

**Tabs:** Overview · Import · Transactions · Shared Expenses · Detailed Breakdowns

**Overview tab:**
- Three side-by-side tables: Monthly, Yearly, and Average spending by category
- Chart panel with two slides (navigated by dots): Monthly Spending Trend (stacked bar) and Income Flow (Sankey diagram)
- Gross/Net toggle and time-range buttons (1M/3M/6M/1Y/5Y) apply to both the tables and the active chart

**Transactions tab:**
- Expenses table and Payments table with shared filters (text search, category, bank category, account, shared status, tag, year, month)
- Edit modal supports: description, category, applied date override, payment splits (for payment transactions), shared status, payer, and per-person share amounts
- Add Transaction modal for manual entries

**Shared Expenses tab:**
- Person filter dropdown (grouped into Owes You / You Owe / Settled Up) and year/month filter with a Clear button
- Unified ledger table showing running balance with period net shown in the filter bar when a year/month is selected
- Transactions with payment splits appear as one row per split at the split's applied date

**Detailed Breakdowns tab:**
- Category and tag selection with tag defaults and a Saved Views panel
- History chart (line) and transaction table for the selected filters
- Comparison mode: toggle multiple saved views to overlay them as color-coded lines on the same chart and merge their transaction rows into one color-coded table

**Import tab:**
- CSV upload with bank name selector
- Plaid bank connection (connect, rename, disconnect)
- Candidate transaction table with conflict-resolution and shared-split modals
- Filtered Out table showing automatically suppressed internal transfers with per-row Restore buttons

**Data island:** Injects `TRACKED_CATEGORIES` as `<script type="application/json">` so `main.js` never needs a separate API call for the category list.

</details>

---

<details>
<summary><strong>static/js/main.js</strong></summary>

All client-side logic. Drives every tab, modal, chart, and data fetch.

### Globals

- `currentViewMode` — `'gross'` or `'net'` (default `'net'`); controls which expense formula is used across all charts and tables
- `overviewChartRange` — active time range for the Overview chart (`'1m'` / `'3m'` / `'6m'` / `'1y'` / `'5y'`)
- `overviewSlide` — 0 = bar chart, 1 = Sankey
- `allTransactions` — cached full transaction list used for client-side filtering
- `TRACKED_CATEGORIES` — parsed from the page's JSON data island

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

### Overview Tab

**`loadSummary()`**
Fetches detailed breakdown data and drives `updateOverviewTable` and `renderPieChart` for Monthly, Yearly, and Average sections, then triggers the active chart.

**`updateOverviewTable(tableId, dataMap)`**
Renders a category-by-amount table using the current gross/net view mode.

**`renderPieChart(divId, dataMap)`**
Renders a Plotly donut chart for a category totals map.

**`setOverviewSlide(index)`**
Switches the Overview chart panel between the bar chart (slide 0) and Sankey (slide 1) and loads the appropriate chart.

**`loadCurrentOverviewChart()`**
Calls `loadOverviewHistoryChart()` or `loadSankeyChart()` depending on the active slide.

**`loadOverviewHistoryChart()`**
Fetches monthly category data and renders a Plotly stacked bar chart with per-month total labels and a dashed average line.

**`loadSankeyChart()`**
Fetches income and expense data and renders a Plotly Sankey (flow) diagram showing income sources → expense categories → savings.

**`setOverviewChartRange(event, range)`**
Updates the active time-range button and reloads the current Overview chart.

**`setViewMode(mode)`**
Switches `currentViewMode` between gross and net and refreshes the Overview tab.

**`loadOverviewInsights()`**
Computes and renders contextual insight panels beside the Overview tables: recent trend, year-over-year comparison, and typical monthly spend.

### Transactions Tab

**`loadFullTransactions()`**
Fetches all transactions (up to 1,000), caches them in `allTransactions`, rebuilds filter dropdowns, and calls `filterTransactions`.

**`filterTransactions()`**
Applies all active filters (search, category, bank category, account, shared status, tag, year, month) client-side and passes results to `renderFilteredTable`. Computes and shows expense/payment totals when any filter is active.

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
Opens the Edit modal, pre-populating it when exactly one transaction is selected. For single-transaction edits includes applied date and payment splits fields. Submits via `/api/transaction/bulk-edit`.

**`openAddModal()` / `closeAddModal()` / `submitAdd()`**
Opens the Add Transaction modal and submits to `/api/transaction/manual`.

**`toggleEditSharedFields()` / `toggleAddSharedFields()`**
Shows or hides the payer and share rows in the Edit and Add modals.

**`updateSharedSentence(prefix)`**
Updates the "who paid / who owes" label and shows/hides the split-row container and "Add Person" button based on the current payer and transaction type. Does not add or remove share rows — row management is handled exclusively by `addShareRow` (via the "Add Person" button) and the per-row × remove button.

**`addShareRow(containerId, name, amount)`**
Appends a person + amount row to the split container in the Edit or Add modal.

**`addSplitRow(date, amount, note)`**
Appends a payment-split row (date + amount + note) to the Payment Splits section in the Edit modal.

**`removeSplitRow(btn)` / `updateSplitTotal()`**
Removes a split row and keeps the running total display updated.

**`setupModalDropdowns(isPaymentEdit)`**
Rebuilds payer and category dropdowns inside the Edit modal for the appropriate transaction type.

### Shared Ledger Tab

**`loadSharedLedger()`**
Fetches the shared ledger with optional person/year/month filters and renders the unified transaction list and running balance. Rebuilds the person dropdown grouped by Owes You / You Owe / Settled Up. When a year/month filter is active, shows the period net in the filter bar.

**`clearSharedFilters()`**
Resets year and month selects to "All" and reloads the ledger.

**`refreshSavedPeople()`**
Re-fetches all known people from `/api/people` and stores them in `savedPeople` for use in payer and share dropdowns throughout the app.

### Tag Modal

**`openTagModal()` / `closeTagModal()` / `submitTags()`**
Opens the tag assignment modal for checked transactions, manages the staged tag set, and submits to `/api/tags`.

**`stageNewTag()`**
Adds a typed tag name to the staged set without submitting.

**`renderStagedTags()` / `renderExistingTags(tags)`**
Re-renders staged tag pills and the existing tag grid in the modal.

**`toggleStagedTag(name, id)` / `removeStagedTag(name)`**
Adds or removes a tag from the staged set.

**`deleteTagGlobal(tagId, tagName)`**
Globally deletes a tag and refreshes all affected UI.

**`removeTag(txnId, tagId)`**
Removes a single tag from a single transaction via the inline × button.

### Detailed Breakdowns Tab

**`loadBreakdownView()`**
Initialises year/month dropdowns, rebuilds the tag checklist, clears comparison selection, loads tag defaults, and fetches saved views.

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
Fetches all saved views, stores them in `_savedBreakdownViews`, and calls `renderSavedViews`.

**`renderSavedViews()`**
Filters to the current category and renders each view as a clickable row. Active comparison views are shown with a color dot and border.

**`toggleComparisonView(viewId)`**
Adds or removes a view from the `activeComparisonViews` map, assigning a color from `COMPARISON_COLORS`. Re-renders the panel and reloads data.

**`saveCurrentBreakdownView()`**
Prompts for a name and saves the current category and tag selection to `/api/breakdown-views`. Overwrites any existing view with the same name.

**`deleteSavedView(id)`**
Removes a view from the comparison set, deletes it from the database, and refreshes the panel.

**`loadComparisonData()`**
Fetches breakdown data for all active comparison views in parallel (using current year/month, view mode, and time range), then calls `renderComparisonChart` and `renderComparisonTable`.

**`renderComparisonChart(results)`**
Plots one colored Plotly line trace per active view. When exactly one view is active, adds a dashed average line.

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
Renders the candidate transaction table with pre-checked checkboxes and color-coded amounts. Always calls `renderFilteredOutTable()` at the end.

**`plaidSelectAll(checked)`**
Checks or unchecks all candidate checkboxes.

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
4. Shows split-configuration modal for descriptions with a prior shared history
5. Enriches each transaction and posts the batch to `/api/plaid/import-transactions`

**`showSharedSplitModal(description, amount, profile)` / `resolveSharedSplit(apply)` / `addSplitPersonRow(name, amount)`**
Manages the split-configuration modal during import. Pre-fills from history, scales amounts if the total changed, and resolves to a shares array or `null`.

**`showConflictModal(description, options)` / `resolveConflict(choice)`**
Manages the category-conflict modal. Presents options as radio buttons and resolves to `{ category, tags }` or `null`.

</details>

---

## Environment Variables

Create a `.env` file in the project root:

```
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_secret
PLAID_ENV=sandbox   # or 'production'
```

## Running Locally

```bash
pip install -r requirements.txt
python app.py
```

The app starts on `http://0.0.0.0:5000`.
