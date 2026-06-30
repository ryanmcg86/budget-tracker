# Infrastructure Diagram

> Open this file in VS Code Markdown Preview (`Cmd+Shift+V`) to render the diagram.

```mermaid
graph TB

    subgraph Browser["🌐 Browser (Safari)"]
        direction TB
        JS["main.js\nvanilla JS + Plotly"]
        Cache["_apiCache\nin-memory URL cache"]
        PlaidLink["Plaid Link\nOAuth popup"]
        JS --- Cache
    end

    subgraph Render["☁️ Render Cloud"]
        direction TB

        subgraph WebService["Web Service  ·  basic-256mb  ·  Python 3.11"]
            Gunicorn["gunicorn\n--worker-class gthread --threads 4"]

            subgraph Flask["Flask Application"]
                direction LR
                AppPy["app.py\nAPI routes"]
                AuthPy["auth.py\nFlask-Login · bcrypt"]
                DBPy["database.py\nDB abstraction\n_PGConn / _SQLiteConn"]
                PlaidPy["plaid_integration.py\nPlaid SDK wrapper"]
            end

            Gunicorn --> Flask
        end

        subgraph RenderDB["Render PostgreSQL  ·  1 GB"]
            direction TB
            Tables["users · transactions · categories\ntags · transaction_tags · transaction_shares\npayment_splits · plaid_accounts\nsettlements · breakdown_views · invite_codes"]
            Indexes["Indexes:\n(user_id, date) · (user_id, applied_date)\n(user_id, is_payment)\npayment_splits(transaction_id)\ntransaction_shares(transaction_id)"]
        end

        AppPy -->|psycopg2| RenderDB
        DBPy -->|psycopg2| RenderDB
    end

    subgraph PlaidAPI["🏦 Plaid API"]
        LinkService["Link Service\nbank OAuth flow"]
        TxnAPI["Transactions API\npersonal_finance_category"]
        AccessTokens["Access Tokens\n(stored in plaid_accounts)"]
    end

    subgraph LocalDev["💻 Local Development"]
        direction TB
        SQLiteDB["SQLite\nbudget.db"]
        Py38["Python 3.8\n/Library/Frameworks/..."]
        DevServer["flask run\n(auto-detects SQLite via DATABASE_URL)"]
        Py38 --> DevServer
        DevServer -->|sqlite3| SQLiteDB
    end

    Browser <-->|"HTTPS · JSON REST API"| Gunicorn
    PlaidLink <-->|"OAuth"| LinkService
    AppPy <-->|"Plaid Python SDK"| TxnAPI
    AppPy -->|"stores token"| AccessTokens
    AccessTokens -->|"used by"| TxnAPI
```

## Key Design Decisions

| Concern | Approach |
|---|---|
| DB portability | `_SQLiteConn` / `_PGConn` wrappers — same SQL, `%s` params everywhere |
| Concurrency | `gthread` worker — 4 threads share 1 process (memory-efficient on 256 MB) |
| Auth | Flask-Login + bcrypt; invite-gated self-registration (`/register` + `create_invite.py` CLI + in-app generator for user_id=1) |
| Performance | Client-side `_apiCache` (URL-keyed); two-phase `loadSummary`; prefetch Sankey + Shared Ledger |
| Plaid | `plaid_integration.py` isolated; `PLAID_ENV` env var switches sandbox ↔ production |

## Scaling Levers (when needed)

1. **Upgrade Render CPU tier** — biggest per-request latency win
2. **DB connection pooling** (pgBouncer or psycopg2 pool) — prevents connection exhaustion under concurrent load
3. **More RAM → more workers** — 512 MB+ enables `--workers 2 --threads 4`
