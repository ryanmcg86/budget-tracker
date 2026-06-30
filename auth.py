from flask import Blueprint, render_template, request, redirect, url_for, flash
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required
import bcrypt
from database import get_db_connection

auth_bp = Blueprint('auth', __name__)
login_manager = LoginManager()


class User(UserMixin):
    def __init__(self, id, email):
        self.id = id
        self.email = email

    @staticmethod
    def get(user_id):
        conn = get_db_connection()
        row = conn.execute('SELECT id, email FROM users WHERE id = %s', (user_id,)).fetchone()
        conn.close()
        return User(row['id'], row['email']) if row else None

    @staticmethod
    def get_by_email(email):
        conn = get_db_connection()
        row = conn.execute('SELECT id, email, password_hash FROM users WHERE email = %s', (email,)).fetchone()
        conn.close()
        return row


@login_manager.user_loader
def load_user(user_id):
    return User.get(int(user_id))


@login_manager.unauthorized_handler
def unauthorized():
    return redirect(url_for('auth.login'))


@auth_bp.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        email = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '').encode()
        row = User.get_by_email(email)
        ph = row['password_hash'] if row else None
        if ph and isinstance(ph, str):
            ph = ph.encode('utf-8')
        if row and bcrypt.checkpw(password, ph):
            login_user(User(row['id'], row['email']), remember=True)
            return redirect(url_for('index'))
        flash('Invalid email or password.')
    return render_template('login.html')


@auth_bp.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        code     = request.form.get('invite_code', '').strip().upper()
        email    = request.form.get('email', '').strip().lower()
        password = request.form.get('password', '')
        confirm  = request.form.get('confirm_password', '')

        conn = get_db_connection()
        code_row = conn.execute(
            'SELECT id FROM invite_codes WHERE code = %s AND used_at IS NULL',
            (code,)
        ).fetchone()
        conn.close()

        if not code_row:
            flash('Invalid or already-used invite code.')
            return render_template('register.html')
        if User.get_by_email(email):
            flash('An account with that email already exists.')
            return render_template('register.html')
        if password != confirm:
            flash('Passwords do not match.')
            return render_template('register.html')
        if len(password) < 8:
            flash('Password must be at least 8 characters.')
            return render_template('register.html')

        hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode('utf-8')
        conn = get_db_connection()
        try:
            conn.execute('INSERT INTO users (email, password_hash) VALUES (%s, %s)', (email, hashed))
            conn.execute(
                'UPDATE invite_codes SET used_at = CURRENT_TIMESTAMP, used_by_email = %s WHERE code = %s',
                (email, code)
            )
            conn.commit()
            user_row = conn.execute('SELECT id, email FROM users WHERE email = %s', (email,)).fetchone()
            login_user(User(user_row['id'], user_row['email']), remember=True)
            return redirect(url_for('index'))
        except Exception:
            flash('An error occurred creating your account. Please try again.')
            return render_template('register.html')
        finally:
            conn.close()

    return render_template('register.html')


@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('auth.login'))
