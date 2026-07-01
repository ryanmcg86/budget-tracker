"""
plaid_integration.py
All Plaid API interactions live here, keeping them separate from the rest of
the app. Flask routes call these functions; nothing else needs to know about
the Plaid SDK internals.
"""

import os
from datetime import date, timedelta
from dotenv import load_dotenv

load_dotenv()

from plaid.api import plaid_api
from plaid.configuration import Configuration, Environment
from plaid.api_client import ApiClient
from plaid.model.link_token_create_request import LinkTokenCreateRequest
from plaid.model.link_token_create_request_user import LinkTokenCreateRequestUser
from plaid.model.item_public_token_exchange_request import ItemPublicTokenExchangeRequest
from plaid.model.transactions_get_request import TransactionsGetRequest
from plaid.model.transactions_get_request_options import TransactionsGetRequestOptions
from plaid.model.country_code import CountryCode
from plaid.model.products import Products


def _get_client():
    env_name = os.getenv('PLAID_ENV', 'sandbox').lower()
    host = Environment.Production if env_name in ('production', 'development') else Environment.Sandbox
    configuration = Configuration(
        host=host,
        api_key={
            'clientId': os.getenv('PLAID_CLIENT_ID'),
            'secret': os.getenv('PLAID_SECRET'),
        }
    )
    return plaid_api.PlaidApi(ApiClient(configuration))


def create_link_token(user_id='spending-tracker-user', redirect_uri=None):
    """
    Creates a Plaid Link token that the frontend uses to open the
    bank-connection popup. redirect_uri is required in production for
    OAuth institutions like Chase that redirect the user off-site.
    """
    client = _get_client()
    params = dict(
        products=[Products('transactions')],
        client_name='Spending Tracker',
        country_codes=[CountryCode('US')],
        language='en',
        user=LinkTokenCreateRequestUser(client_user_id=user_id)
    )
    if redirect_uri:
        params['redirect_uri'] = redirect_uri
    request = LinkTokenCreateRequest(**params)
    response = client.link_token_create(request)
    return response['link_token']


def exchange_public_token(public_token):
    """
    Exchanges the temporary public token (returned by Plaid Link after the
    user logs into their bank) for a permanent access token. Called once
    per account connection.
    Returns {'access_token': ..., 'item_id': ...}
    """
    client = _get_client()
    request = ItemPublicTokenExchangeRequest(public_token=public_token)
    response = client.item_public_token_exchange(request)
    return {
        'access_token': response['access_token'],
        'item_id': response['item_id'],
    }


def fetch_transactions(access_token, start_date: date, account_ids: list = None, end_date: date = None):
    """
    Pulls transactions for a connected account from start_date through end_date (defaults to today).
    Returns a list of dicts shaped to match the spending tracker's transactions
    table, ready for the frontend to display as sync candidates.

    Plaid paginates at 500 transactions per call, so we loop until we have
    them all.
    """
    client = _get_client()
    if end_date is None:
        end_date = date.today()

    options = TransactionsGetRequestOptions()
    if account_ids:
        options.account_ids = account_ids
    # Request the newer category taxonomy so bank_category is populated
    options.include_personal_finance_category = True

    all_transactions = []
    offset = 0

    while True:
        options.count = 500
        options.offset = offset

        request = TransactionsGetRequest(
            access_token=access_token,
            start_date=start_date,
            end_date=end_date,
            options=options
        )
        response = client.transactions_get(request)
        txns = response['transactions']
        all_transactions.extend(txns)

        if len(all_transactions) >= response['total_transactions']:
            break
        offset += len(txns)

    return [_shape_transaction(t) for t in all_transactions]


def _shape_transaction(plaid_txn):
    """
    Maps a raw Plaid transaction object to a dict that mirrors the budget
    tracker's transactions table columns.

    Plaid's newer API uses personal_finance_category (with 'primary' and
    'detailed' sub-fields) instead of the legacy 'category' list. We try
    the newer field first and fall back to the legacy one.
    """
    amount = float(plaid_txn['amount'])

    merchant = plaid_txn.get('merchant_name') or ''
    description = plaid_txn.get('name') or merchant or 'Unknown'

    # Try personal_finance_category first (newer API), then fall back to
    # the legacy category list (e.g. ['Food and Drink', 'Restaurants']).
    bank_category = ''
    pfc = plaid_txn.get('personal_finance_category')
    if pfc:
        # 'detailed' is the most specific, e.g. 'FOOD_AND_DRINK_RESTAURANTS'
        # 'primary' is broader, e.g. 'FOOD_AND_DRINK'
        # We use detailed and humanise it slightly by replacing underscores
        detailed = pfc.get('detailed') or pfc.get('primary') or ''
        bank_category = detailed.replace('_', ' ').title()
    else:
        legacy_cats = plaid_txn.get('category') or []
        bank_category = legacy_cats[-1] if legacy_cats else ''

    return {
        'plaid_transaction_id': plaid_txn['transaction_id'],
        'date': str(plaid_txn['date']),
        'description': description,
        'merchant': merchant,
        'amount': amount,
        'bank_category': bank_category,
        'category': '',          # left blank — user assigns via Edit
        'is_payment': amount < 0,
        'card_name': '',         # filled in by the route using the account's card_name
        'pending': bool(plaid_txn.get('pending', False)),
    }