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
        row = conn.execute('SELECT id, email FROM users WHERE id = ?', (user_id,)).fetchone()
        conn.close()
        return User(row['id'], row['email']) if row else None

    @staticmethod
    def get_by_email(email):
        conn = get_db_connection()
        row = conn.execute('SELECT id, email, password_hash FROM users WHERE email = ?', (email,)).fetchone()
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
        if row and bcrypt.checkpw(password, row['password_hash']):
            login_user(User(row['id'], row['email']), remember=True)
            return redirect(url_for('index'))
        flash('Invalid email or password.')
    return render_template('login.html')


@auth_bp.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('auth.login'))
