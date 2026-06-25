# Budget Tracker

A personal finance web app built with Flask and SQLite. Transactions can be imported via CSV upload or fetched live from connected bank accounts through the Plaid API. The app tracks spending by category, handles shared expenses and bill splitting, and provides detailed breakdowns with tagging and saved views.

---

## Project Structure

```
budget-tracker/
├── app.py                  # Flask application — all API routes
├── database.py             # Database schema, migrations, and query helpers
├── plaid_integration.py    # Plaid API client (link tokens, token exchange, transaction fetch)
├── static/js/main.js       # All frontend logic (vanilla JS)
├── templates/index.html    # Single-page HTML shell
├── debug_import.py         # One-off debug script (safe to delete)
├── migrate_drop_unique.py  # One-off schema migration script (safe to delete)
└── budget.db               # SQLite database (auto-created on first run)
```

---

## `database.py`

Owns the database layer. All other files import from here rather than opening `budget.db` directly.

### Constants

**`TRACKED_CATEGORIES`**
The canonical list of ten spending categories used throughout the app (Streaming, Transportation, Food/Drink, etc.). Injected into `index.html` at render time so the frontend and backend always share the same list.

### Functions

**`get_db_connection()`**
Opens and returns a connection to `budget.db` with `row_factory = sqlite3.Row` set so query results can be accessed by column name.

**`init_db()`**
Called once at app startup. Creates all tables if they don't exist and applies incremental column migrations for databases created by older versions of the app. Also calls `clean_account_names()` to normalise any account name variations left over from CSV imports. Tables created:

| Table | Purpose |
|---|---|
| `transactions` | Core transaction ledger |
| `categories` | Category name registry (informational) |
| `settlements` | Records when a shared-expense payment is matched against an expense |
| `transaction_shares` | Per-person share amounts for a shared transaction |
| `tags` | Tag name registry |
| `transaction_tags` | Many-to-many link between transactions and tags |
| `tag_defaults` | Default tags to apply per category on the Detailed Breakdowns page |
| `plaid_accounts` | Connected bank accounts (stores Plaid access tokens) |
| `breakdown_views` | Saved tag+category combinations for the Detailed Breakdowns page |

**`insert_transactions(transactions)`**
Bulk-inserts a list of transaction tuples (from CSV processing). Uses `INSERT OR IGNORE` so rows that already exist are silently skipped. Returns the number of rows actually inserted.

**`get_monthly_summary()`**
Returns total spend and transaction count grouped by month. Used internally; the Overview tab now calls `get_detailed_breakdown` instead.

**`get_category_breakdown(start_date, end_date)`**
Returns total spend grouped by user-assigned category, optionally filtered to a date range.

**`get_all_transactions(limit)`**
Returns the most recent N transactions including their settlement count. Superseded in the API layer by the inline query in `app.py`'s `/api/transactions` route, which also joins tags.

**`get_detailed_summary(year, month)`**
Returns year-to-date and (optionally) single-month category totals. Legacy helper; the active route uses `get_detailed_breakdown` instead.

**`get_detailed_breakdown(year, month)`**
The primary data source for the Overview tab. Returns three maps — `month_totals`, `year_totals`, and `year_averages` — each keyed by category with both `gross` and `net` values. Net subtracts any reimbursement amounts so shared expenses only count as the user's out-of-pocket cost.

**`get_overview_history(year, month, view_mode, time_range)`**
Powers the stacked bar chart on the Overview tab. Returns a list of month labels and a per-category list of totals for the requested time range ending at the given year/month.

**`clean_account_names()`**
Normalises `card_name` values left over from CSV imports (e.g. collapses various Chase name strings to simply `"Chase"`). Run automatically at startup.

**`migrate_to_unique()`**
Historical one-time migration that added a `UNIQUE` constraint to the transactions table. No longer called; kept for reference.

---

## `plaid_integration.py`

Thin wrapper around the Plaid Python SDK. Flask routes in `app.py` call these functions; nothing else should import the Plaid SDK directly.

### Functions

**`_get_client()`**
Builds and returns a configured `PlaidApi` client using credentials from `.env`. Switches between Sandbox and Production environments based on the `PLAID_ENV` variable.

**`create_link_token(user_id)`**
Requests a short-lived Link token from Plaid. The frontend passes this token to the Plaid Link SDK to open the bank-connection popup.

**`exchange_public_token(public_token)`**
Exchanges the temporary `public_token` (returned by Plaid Link after the user authenticates with their bank) for a permanent `access_token`. Called once per account connection. Returns `{ access_token, item_id }`.

**`fetch_transactions(access_token, start_date, account_ids)`**
Pulls all transactions for a connected account from `start_date` through today, handling Plaid's 500-transaction pagination automatically. Returns a list of dicts shaped to match the app's transactions table, via `_shape_transaction`.

**`_shape_transaction(plaid_txn)`**
Maps a raw Plaid transaction object to the app's internal dict format. Prefers the newer `personal_finance_category` taxonomy for `bank_category`, falling back to the legacy category list. Amounts follow Plaid's convention: positive = debit (money leaving the account), negative = credit (money arriving).

---

## `app.py`

The Flask application. Every URL the frontend calls is defined here. Helper functions that don't serve a route live at the top of the Plaid section.

### Helper Functions

**`process_csv(df, card_name)`**
Parses a pandas DataFrame from a CSV upload. Auto-detects date, description, amount, and category columns by name. Normalises amounts (expenses stored as positive), detects payments/credits, deduplicates rows that appear more than once within the same file, and calls `insert_transactions`. Returns the number of rows inserted.

**`_filter_internal_transfers(candidates)`**
Splits a Plaid candidate list into `(kept, removed)` based on known internal transfer pairs. Known pairs are defined in `TRANSFER_PAIRS` — currently: Venmo "Standard transfer" ↔ Capital One "Venmo" (cash transfer between own accounts), and Capital One "CHASE CREDIT CRD" ↔ Chase "Payment Thank You-Mobile" (monthly credit card bill payment). Pairs are matched on equal-and-opposite amounts within a 5-day date window. Returns a tuple so the caller can expose both lists to the user.

### Routes

#### Core

**`GET /`**
Renders `index.html`, injecting `TRACKED_CATEGORIES` from `database.py` as a JSON data island so the frontend never needs to fetch the category list separately.

**`POST /upload`**
Accepts a CSV file and a `bank_name` form field. Reads the file (trying UTF-8 then Latin-1), delegates to `process_csv`, and returns the number of rows inserted.

#### Transactions

**`GET /api/transactions`**
Returns up to N transactions (default 100, configurable via `?limit=`) ordered newest-first, with each transaction's tags included as a nested list.

**`GET /api/transaction/<id>/details`**
Returns a single transaction by ID, including its share records and settlement count. Used to pre-populate the Edit modal.

**`POST /api/transaction/manual`**
Inserts a manually entered transaction. Accepts `is_payment`, `is_shared`, `payer`, and a `shares` list so a new shared expense can be fully configured in one call.

**`DELETE /api/transaction/<id>`**
Deletes a transaction and cascades to remove any associated `transaction_shares` and `settlements` rows.

**`POST /api/transaction/<id>/toggle-shared`**
Flips the `is_shared` boolean on a single transaction.

**`POST /api/transaction/<id>/toggle-payment`**
Flips the `is_payment` boolean, moving a transaction between the Expenses and Payments tables.

**`POST /api/transaction/bulk-edit`**
Updates description, category, and/or shared status for a list of transaction IDs in one call. When setting shared status, it fully replaces the `transaction_shares` rows and re-links any existing settlements to the new share IDs so settlement history isn't broken.

#### Overview & Summary

**`GET /api/summary`**
Returns the raw monthly summary from `get_monthly_summary()`.

**`GET /api/detailed-summary`**
Returns month totals, year totals, and year averages for the Overview tab, sourced from `get_detailed_breakdown`. Accepts `?year=` and `?month=` query params.

**`GET /api/overview-history`**
Returns the stacked bar chart data for the Overview tab. Accepts `?year=`, `?month=`, `?view_mode=` (gross/net), and `?time_range=` (3m/6m/1y/5y).

#### Categories & Rules

**`GET /api/categories`**
Returns total spend grouped by category.

**`GET|POST /api/rules`**
Lists all category rules (GET) or creates a new one and immediately re-applies all rules to existing transactions (POST).

**`DELETE /api/rules/<id>`**
Deletes a single category rule.

#### Shared Expenses & Ledger

**`GET /api/shared-ledger`**
Returns the full shared-expense ledger, optionally filtered to a single person via `?person=`. Computes a running balance showing who owes whom and by how much. Also returns all known people grouped into "Owes Me", "I Owe", and "Settled" for the dropdown.

**`GET /api/people`**
Returns a deduplicated list of all person names that appear as payers or share recipients.

#### Tags

**`GET|POST /api/tags`**
Lists all tags (GET) or attaches one or more tag names to a list of transaction IDs (POST), creating new tags as needed.

**`DELETE /api/tag/<id>`**
Globally deletes a tag, removing it from all transactions and tag defaults.

**`DELETE /api/transaction/<id>/tag/<tag_id>`**
Removes a single tag from a single transaction without deleting the tag globally.

**`GET|POST /api/tag-defaults`**
Gets or sets the default tags for a given category on the Detailed Breakdowns page.

#### Detailed Breakdowns

**`GET /api/breakdown-report`**
Returns graph data (monthly totals) and table data (individual transactions) for the selected category, tags, year/month, view mode, and time range. The table covers the full time range shown on the graph, not just the selected month.

**`GET|POST /api/breakdown-views`**
Lists all saved breakdown views (GET) or creates/updates one by name (POST). Each view stores a name, category, and tag ID list.

**`DELETE /api/breakdown-views/<id>`**
Deletes a saved breakdown view.

#### Plaid Integration

**`POST /api/plaid/link-token`**
Calls `plaid_integration.create_link_token()` and returns the token to the frontend so it can open the Plaid Link popup.

**`POST /api/plaid/exchange-token`**
Called after the user successfully connects a bank in Plaid Link. Exchanges the temporary public token for a permanent access token and stores the account record in `plaid_accounts`.

**`GET /api/plaid/accounts`**
Returns all connected Plaid accounts (no tokens exposed to the client).

**`DELETE|PATCH /api/plaid/accounts/<id>`**
Disconnects a Plaid account (DELETE) or renames its display name (PATCH).

**`POST /api/plaid/fetch-transactions`**
Fetches candidate transactions from all connected accounts since a given date, filters out any already in the database by Plaid transaction ID, and splits the remainder through `_filter_internal_transfers`. Returns `{ candidates: [...], filtered_out: [...] }` so the frontend can display both the importable list and the automatically suppressed transfers side-by-side.

**`POST /api/plaid/lookup-profiles`**
Given a list of transaction descriptions, returns the existing category and tag profile for each one — `unique` if all prior transactions share the same category/tags, `conflict` if they differ, or `none` if unseen. Used during import to auto-apply or prompt for resolution.

**`POST /api/plaid/lookup-shared-profiles`**
Given a list of transaction descriptions, returns the most recent shared-expense split profile for each one (who owes what share). Used during import to suggest pre-filled splits for recurring shared transactions.

**`POST /api/plaid/import-transactions`**
Inserts the user-selected transactions into the database. For each transaction: backfills the `plaid_transaction_id` onto an existing CSV-imported row if one matches, otherwise inserts a new row. Also applies resolved tags and shared split data (setting `is_shared`, `payer`, `transaction_shares`, and `reimbursement_amount`).

---

## `static/js/main.js`

All client-side logic. The page is a single HTML file; this script drives every tab, modal, chart, and data fetch. Functions are grouped by feature area below.

### Initialisation

**`setupCategoryDropdowns()`**
Populates every `<select>` that lists user-assignable categories using the `TRACKED_CATEGORIES` array parsed from the page's JSON data island.

**`setupYearDropdown()`**
Populates the year `<select>` elements with years from 2026 through the current year.

**`updateMonthDropdown()` / `updateBreakdownMonthDropdown()` / `updateMonthDropdownGeneric(yearId, monthId)`**
Rebuilds a month dropdown based on the selected year, capping the list at the current month when the current year is selected.

### Utilities

**`formatDate(dateStr)`**
Converts a `YYYY-MM-DD` string to a human-readable "Mon D, YYYY" label using local time (avoids the UTC off-by-one-day issue).

**`formatMonth(monthStr)`**
Converts a `YYYY-MM` string to a "Month YYYY" label.

**`getAccountClass(accountName)`**
Returns a CSS class string for an account name badge (Chase, Capital One, Venmo, or a generic fallback).

**`renderTxnTags(txn)`**
Returns the HTML string for a transaction's tag pills, each with an inline × remove button.

**`showStatus(message, type)`**
Displays a status message banner (success or error) that auto-hides after 5 seconds.

### Overview Tab

**`loadSummary()`**
Fetches detailed breakdown data for the selected year/month and calls `updateOverviewTable` and `renderPieChart` for the Monthly, Yearly, and Average sections, then triggers the history chart.

**`updateOverviewTable(tableId, dataMap)`**
Renders a category-by-amount table row for each tracked category, respecting the current gross/net view mode. Updates the corresponding grand-total footer value.

**`renderPieChart(divId, dataMap)`**
Renders a Plotly donut chart for the given category totals map.

**`loadOverviewHistoryChart()`**
Fetches monthly category data for the selected time range and renders a stacked bar chart with per-month total labels and an average line.

**`setOverviewChartRange(event, range)`**
Updates the active time-range button and reloads the overview history chart.

**`setViewMode(mode)`**
Switches the global `currentViewMode` between `'gross'` and `'net'` and refreshes the Overview tab.

### Transactions Tab

**`loadFullTransactions()`**
Fetches all transactions (up to 1,000), stores them in `allTransactions`, rebuilds the filter dropdowns, and calls `filterTransactions`.

**`filterTransactions()`**
Applies all active filter controls (search text, category, bank category, account, shared status, tag, year, month) against `allTransactions` and passes the result to `renderFilteredTable`. Also computes and shows expense/payment totals when any filter is active.

**`renderFilteredTable(data)`**
Splits filtered transactions into expenses and payments and renders each into its respective table, including checkboxes, tags, and shared indicators.

**`updateBankCategoryDropdown()` / `updateBankNameDropdown()`**
Rebuild the Bank Category and Account Name filter dropdowns from the current `allTransactions` list.

**`deleteTransaction(txnId)`**
Confirms (with a warning if settlements are involved), deletes the transaction, and refreshes the transactions and overview data.

**`bulkDelete()`**
Deletes all checked transactions after a confirmation prompt that escalates if any have settlements.

**`bulkTogglePayment()`**
Moves all checked transactions between Expenses and Payments by toggling their `is_payment` flag.

**`toggleAll(type)`**
Checks or unchecks all checkboxes in the Expenses or Payments table in sync with the master checkbox.

**`openEditModal()` / `closeEditModal()` / `submitEdit()`**
Opens the Edit modal, optionally pre-populating it with the selected transaction's data (when exactly one is selected), and submits changes via `/api/transaction/bulk-edit`.

**`openAddModal()` / `closeAddModal()` / `submitAdd()`**
Opens the Add Transaction modal and submits the new transaction to `/api/transaction/manual`.

**`toggleEditSharedFields()` / `toggleAddSharedFields()`**
Shows or hides the shared-expense fields (payer, shares) in the Edit and Add modals.

**`updateSharedSentence(prefix)`**
Updates the "who paid / who owes" sentence UI inside the shared fields based on the current payer and whether the modal is in payment or expense mode.

**`addShareRow(containerId, name, amount)`**
Appends a person + amount row to the split container inside the Edit or Add modal.

**`setupModalDropdowns(isPaymentEdit)`**
Rebuilds the payer and category dropdowns inside the Edit modal, using the payment or expense category list as appropriate.

### Shared Ledger Tab

**`loadSharedLedger()`**
Fetches the shared ledger (optionally filtered by person) and renders the unified transaction list and running balance. Rebuilds the person dropdown grouped by "Owes You", "You Owe", and "Settled Up".

**`refreshSavedPeople()`**
Re-fetches the list of all known people from `/api/people` and stores it in `savedPeople`, which populates payer and share dropdowns throughout the app.

**`processSettlement()`**
Reads the selected payment and checked expenses from the settlement UI and posts them to `/api/settle`.

### Tag Modal

**`openTagModal()` / `closeTagModal()` / `submitTags()`**
Opens the tag assignment modal for the currently checked transactions, manages the staged tag set, and submits to `/api/tags`.

**`stageNewTag()`**
Adds a typed tag name to the staged set without submitting yet.

**`renderStagedTags()` / `renderExistingTags(tags)`**
Re-renders the staged tag pills and the existing tag pill grid inside the modal.

**`toggleStagedTag(name, id)` / `removeStagedTag(name)`**
Adds/removes a tag from the staged set and updates pill highlighting.

**`deleteTagGlobal(tagId, tagName)`**
Globally deletes a tag from the database and refreshes all affected UI.

**`removeTag(txnId, tagId)`**
Removes a single tag from a single transaction via the inline × button on a tag pill.

### Detailed Breakdowns Tab

**`loadBreakdownView()`**
Called when the tab opens or the category dropdown changes. Initialises year/month dropdowns, rebuilds the tag checklist, clears the active comparison selection, loads tag defaults, and fetches saved views.

**`loadBreakdownData()`**
Fetches chart and table data for the current category, selected tags, year/month, view mode, and time range. If any comparison views are active, delegates to `loadComparisonData()` instead.

**`setBreakdownViewMode(mode)`**
Switches the breakdown view mode between gross and net and reloads the data.

**`setBreakdownChartRange(event, range)`**
Updates the active time-range button and reloads the breakdown data.

**`loadTagDefaults()` / `saveTagDefaults()`**
Loads or saves the default tag selection for the current category via `/api/tag-defaults`.

**`deselectAllTags()`**
Unchecks all tag checkboxes and reloads the breakdown data.

### Saved Views & Comparison Mode

**`loadSavedViews()`**
Fetches all saved views from `/api/breakdown-views`, stores them in `_savedBreakdownViews`, and calls `renderSavedViews`.

**`renderSavedViews()`**
Filters `_savedBreakdownViews` to the current category and renders each as a clickable row in the Saved Views panel. Active (comparison-selected) views are shown with a colored dot and border matching their assigned comparison color.

**`toggleComparisonView(viewId)`**
Adds or removes a view from the `activeComparisonViews` map, assigning a color from `COMPARISON_COLORS` when adding. Re-renders the panel and reloads the data.

**`saveCurrentBreakdownView()`**
Prompts for a name and saves the current category and tag selection to `/api/breakdown-views`. Overwrites any existing view with the same name.

**`deleteSavedView(id)`**
Removes a view from the comparison set, deletes it from the database, and refreshes the panel.

**`loadComparisonData()`**
Called when one or more saved views are active. Fetches breakdown data for all active views in parallel (using the current year/month and global view mode / time range), then calls `renderComparisonChart` and `renderComparisonTable`.

**`renderComparisonChart(results)`**
Plots one colored Plotly line trace per active view on the same axes for direct comparison. When exactly one view is active, also adds a dashed red average line (matching the single-view chart behavior).

**`renderComparisonTable(results)`**
Merges all transactions from all active views, sorts by date descending, groups by month with dark header rows, and renders each transaction row with a left-border color and view-name label matching its graph line color.

### Plaid Import Tab

**`initPlaidLink()`**
Fetches a Link token from the backend and initialises the Plaid Link handler. Called on page load and after each successful account connection.

**`openPlaidLink()`**
Opens the Plaid Link popup using the initialised handler.

**`loadPlaidAccounts()`**
Fetches connected accounts and renders them in the account list with Rename and Disconnect controls.

**`renamePlaidAccount(id, currentName)` / `disconnectPlaidAccount(id, name)`**
PATCH or DELETE a connected account record.

**`fetchPlaidCandidates()`**
Posts the selected since-date to `/api/plaid/fetch-transactions`, stores the returned `candidates` list in `plaidCandidates` and the `filtered_out` list in `plaidFilteredOut`, then calls `renderPlaidCandidates`.

**`renderPlaidCandidates()`**
Renders the candidate transaction table with pre-checked checkboxes and color-coded amounts. Always calls `renderFilteredOutTable()` at the end so the Filtered Out section stays in sync.

**`plaidSelectAll(checked)`**
Checks or unchecks all candidate checkboxes.

**`moveToFiltered()`**
Moves all currently checked rows from the candidates table into `plaidFilteredOut` and re-renders both tables. Used when you want to manually suppress a transaction that wasn't caught by the automatic filter.

**`moveBackToImportable(plaidId)`**
Moves a single transaction from `plaidFilteredOut` back into `plaidCandidates` (re-sorted by date) and re-renders both tables. Exposed as a "Restore" button on each row in the Filtered Out table.

**`renderFilteredOutTable()`**
Renders the Filtered Out section below the candidates table. Shows transactions that were either automatically removed by `_filter_internal_transfers` or manually filtered by the user. Hidden when the list is empty. Each row includes a Restore button that calls `moveBackToImportable`.

**`importSelectedPlaidTransactions()`**
Orchestrates the full import flow for checked candidates:
1. Looks up existing category/tag profiles for each unique description.
2. Looks up existing shared-split profiles for each unique description.
3. Shows a conflict-resolution modal for any descriptions with inconsistent historical profiles.
4. Shows a split-configuration modal for any descriptions with a prior shared history.
5. Enriches each transaction with the resolved category, tags, and shares, then posts the batch to `/api/plaid/import-transactions`.

**`showSharedSplitModal(description, amount, profile)` / `resolveSharedSplit(apply)` / `addSplitPersonRow(name, amount)`**
Manages the split-configuration modal shown during import. Pre-fills from the historical profile, scales share amounts proportionally if the total has changed, and resolves to a shares array (or `null` if not shared).

**`showConflictModal(description, options)` / `resolveConflict(choice)`**
Manages the category-conflict modal shown when a description has inconsistent historical profiles. Presents the options as radio buttons and resolves to the chosen `{ category, tags }` object (or `null` to leave blank).

---

## `debug_import.py`

A standalone diagnostic script used to investigate why duplicate Plaid transactions weren't being inserted. Prints the `transactions` table schema, current indexes, recent rows, and simulates an insert without saving. **Safe to delete.**

---

## `migrate_drop_unique.py`

A one-time migration script that removed the `UNIQUE(date, description, amount, card_name)` constraint from the `transactions` table and replaced it with a partial unique index on `plaid_transaction_id`. This allows the same transaction to appear on multiple cards (e.g. a Metro card used twice on the same day) while still deduplicating Plaid imports. **Safe to delete.**

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
