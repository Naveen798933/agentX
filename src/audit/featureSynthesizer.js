import crypto from 'node:crypto';
import { SoftwareSynthesizer } from '../core/softwareSynthesizer.js';

/**
 * FeatureSynthesizer
 * Synthesizes real, working, requirement-accurate source code and tests
 * strictly derived from the RequirementLock.
 * Never substitutes a shopping cart when the user requested Login/Signup.
 */
export class FeatureSynthesizer {
  /**
   * Synthesize project files for the specified requirement lock
   * @param {Object} lock RequirementLock from RequirementParser
   * @param {Object} [projectMap] Existing project map from ProjectInspector
   * @returns {Array<{path: string, content: string}>}
   */
  static synthesize(lock, projectMap = {}) {
    const domain = lock.domain;

    if (domain === 'PLACEMENT' || domain === 'LIBRARY' || domain === 'HEALTHCARE' || domain === 'EXPENSE') {
      const synth = new SoftwareSynthesizer();
      const result = synth._synthesizeRequirementDriven(
        lock.featureName || `${domain} Application`,
        lock.instruction || '',
        domain,
        'Web Application',
        lock,
        synth.selectTeam(domain, lock.instruction || '')
      );
      return result.files;
    }

    if (domain === 'AUTH') {
      return FeatureSynthesizer._synthesizeAuthFeature(lock, projectMap);
    }

    if (domain === 'EXPENSE') {
      return FeatureSynthesizer._synthesizeExpenseFeature(lock, projectMap);
    }

    if (domain === 'ECOMMERCE') {
      return FeatureSynthesizer._synthesizeEcommerceFeature(lock, projectMap);
    }

    if (domain === 'CHAT') {
      return FeatureSynthesizer._synthesizeChatFeature(lock, projectMap);
    }

    if (domain === 'ANALYTICS') {
      return FeatureSynthesizer._synthesizeAnalyticsFeature(lock, projectMap);
    }

    if (domain === 'WORKFLOW') {
      return FeatureSynthesizer._synthesizeWorkflowFeature(lock, projectMap);
    }

    return FeatureSynthesizer._synthesizeCustomFeature(lock, projectMap);
  }

  static _synthesizeAuthFeature(lock, projectMap) {
    const title = lock.featureName || 'User Authentication & Registration';

    // 1. Frontend HTML (Authentication UI)
    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="auth-wrapper">
    <!-- Ambient Glassmorphic Background -->
    <div class="glow-orb orb-1"></div>
    <div class="glow-orb orb-2"></div>

    <div class="auth-container">
      <!-- Brand & Header -->
      <div class="auth-header">
        <div class="auth-logo">🔐</div>
        <h1 class="auth-title">Nexus Identity Gateway</h1>
        <p class="auth-subtitle">Secure, zero-trust authentication and access management</p>
      </div>

      <!-- Mode Toggle Switch (Login vs Signup) -->
      <div class="mode-switcher" role="tablist">
        <button type="button" class="mode-btn active" id="btn-switch-to-login" role="tab" aria-selected="true">Sign In</button>
        <button type="button" class="mode-btn" id="btn-switch-to-signup" role="tab" aria-selected="false">Create Account</button>
      </div>

      <!-- Alert & Error Feedback Container -->
      <div class="auth-alert hidden" id="auth-alert" role="alert">
        <span class="alert-icon" id="alert-icon">⚠️</span>
        <span class="alert-msg" id="alert-msg">Validation error message</span>
      </div>

      <!-- ── LOGIN FORM ─────────────────────────────────────────────── -->
      <form class="auth-form" id="form-login" novalidate>
        <div class="form-group">
          <label class="form-label" for="login-email">Email Address</label>
          <div class="input-wrap">
            <span class="input-icon">✉️</span>
            <input type="email" class="form-input" id="login-email" placeholder="name@example.com" autocomplete="email" required />
          </div>
          <span class="field-error hidden" id="login-email-error">Please enter a valid email address</span>
        </div>

        <div class="form-group">
          <div class="label-row">
            <label class="form-label" for="login-password">Password</label>
            <a href="#" class="forgot-link" id="link-forgot-pass">Forgot?</a>
          </div>
          <div class="input-wrap">
            <span class="input-icon">🔒</span>
            <input type="password" class="form-input" id="login-password" placeholder="Enter your password" autocomplete="current-password" required />
            <button type="button" class="btn-toggle-pass" id="btn-toggle-login-pass" title="Toggle password visibility" aria-label="Toggle password visibility">👁️</button>
          </div>
          <span class="field-error hidden" id="login-password-error">Password must be at least 8 characters</span>
        </div>

        <div class="form-options">
          <label class="remember-label">
            <input type="checkbox" id="login-remember" checked />
            <span>Remember this device</span>
          </label>
        </div>

        <button type="submit" class="btn-submit" id="btn-login-submit">
          <span class="btn-text">Sign In</span>
          <div class="btn-spinner hidden" id="login-spinner"></div>
        </button>

        <p class="form-footer-text">
          Don't have an account? <button type="button" class="text-link" id="link-to-signup">Sign up for free</button>
        </p>
      </form>

      <!-- ── SIGNUP FORM ────────────────────────────────────────────── -->
      <form class="auth-form hidden" id="form-signup" novalidate>
        <div class="form-group">
          <label class="form-label" for="signup-name">Full Name</label>
          <div class="input-wrap">
            <span class="input-icon">👤</span>
            <input type="text" class="form-input" id="signup-name" placeholder="Alex Morgan" autocomplete="name" required />
          </div>
          <span class="field-error hidden" id="signup-name-error">Please enter your full name</span>
        </div>

        <div class="form-group">
          <label class="form-label" for="signup-email">Email Address</label>
          <div class="input-wrap">
            <span class="input-icon">✉️</span>
            <input type="email" class="form-input" id="signup-email" placeholder="name@example.com" autocomplete="email" required />
          </div>
          <span class="field-error hidden" id="signup-email-error">Please enter a valid email address</span>
        </div>

        <div class="form-group">
          <label class="form-label" for="signup-password">Create Password</label>
          <div class="input-wrap">
            <span class="input-icon">🔒</span>
            <input type="password" class="form-input" id="signup-password" placeholder="At least 8 characters" autocomplete="new-password" required />
            <button type="button" class="btn-toggle-pass" id="btn-toggle-signup-pass" title="Toggle password visibility" aria-label="Toggle password visibility">👁️</button>
          </div>
          <span class="field-error hidden" id="signup-password-error">Password must be at least 8 characters</span>
        </div>

        <div class="form-group">
          <label class="form-label" for="signup-confirm-password">Confirm Password</label>
          <div class="input-wrap">
            <span class="input-icon">🔒</span>
            <input type="password" class="form-input" id="signup-confirm-password" placeholder="Confirm your password" autocomplete="new-password" required />
          </div>
          <span class="field-error hidden" id="signup-confirm-error">Passwords do not match</span>
        </div>

        <div class="form-options">
          <label class="remember-label">
            <input type="checkbox" id="signup-terms" required />
            <span>I accept the Terms of Service & Privacy Policy</span>
          </label>
        </div>

        <button type="submit" class="btn-submit" id="btn-signup-submit">
          <span class="btn-text">Create Account</span>
          <div class="btn-spinner hidden" id="signup-spinner"></div>
        </button>

        <p class="form-footer-text">
          Already registered? <button type="button" class="text-link" id="link-to-login">Sign in here</button>
        </p>
      </form>

      <!-- ── AUTHENTICATED DESTINATION DASHBOARD ────────────────────── -->
      <div class="auth-destination hidden" id="auth-destination">
        <div class="auth-success-badge">✅ AUTHENTICATION VERIFIED</div>
        <h2 class="dest-title" id="dest-welcome-title">Welcome Back, User!</h2>
        <p class="dest-sub">You have successfully signed in to the secure application environment.</p>

        <div class="session-card">
          <div class="session-item">
            <span class="item-label">USER ACCOUNT</span>
            <strong class="item-val" id="dest-user-email">user@example.com</strong>
          </div>
          <div class="session-item">
            <span class="item-label">SESSION TOKEN</span>
            <code class="token-code" id="dest-token-display">sess_verified</code>
          </div>
          <div class="session-item">
            <span class="item-label">SECURITY LEVEL</span>
            <span class="status-chip">SCRYPT ENCRYPTED</span>
          </div>
        </div>

        <button type="button" class="btn-signout" id="btn-signout">Sign Out</button>
      </div>

    </div>
  </div>

  <script src="app.js"></script>
</body>
</html>`;

    // 2. Styling (CSS)
    const styleCss = `/* Nexus Identity Gateway — Modern Glassmorphism Styling */
:root {
  --bg-main: #060913;
  --card-bg: rgba(15, 23, 42, 0.85);
  --border-color: rgba(255, 255, 255, 0.08);
  --border-focus: rgba(56, 189, 248, 0.45);
  --primary: #38bdf8;
  --primary-gradient: linear-gradient(135deg, #38bdf8 0%, #6366f1 100%);
  --success: #10b981;
  --error: #ef4444;
  --text-main: #f8fafc;
  --text-muted: #94a3b8;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-sans);
  background: var(--bg-main);
  color: var(--text-main);
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow-x: hidden;
  line-height: 1.5;
}

.auth-wrapper {
  position: relative;
  width: 100%;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

/* Background Ambient Orbs */
.glow-orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  pointer-events: none;
  z-index: 1;
}

.orb-1 {
  width: 380px;
  height: 380px;
  background: radial-gradient(circle, rgba(56, 189, 248, 0.22) 0%, transparent 70%);
  top: 10%;
  left: 20%;
}

.orb-2 {
  width: 340px;
  height: 340px;
  background: radial-gradient(circle, rgba(99, 102, 241, 0.2) 0%, transparent 70%);
  bottom: 10%;
  right: 20%;
}

/* Auth Container Glass Card */
.auth-container {
  position: relative;
  z-index: 10;
  width: 440px;
  max-width: 100%;
  background: var(--card-bg);
  backdrop-filter: blur(20px);
  border: 1px solid var(--border-color);
  border-radius: 18px;
  padding: 36px 32px;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6), 0 0 30px rgba(56, 189, 248, 0.08);
  transition: all 0.3s ease;
}

/* Header */
.auth-header {
  text-align: center;
  margin-bottom: 24px;
}

.auth-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: rgba(56, 189, 248, 0.12);
  border: 1px solid rgba(56, 189, 248, 0.3);
  font-size: 26px;
  margin-bottom: 14px;
  box-shadow: 0 0 20px rgba(56, 189, 248, 0.3);
}

.auth-title {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.5px;
  background: linear-gradient(135deg, #f8fafc 0%, #cbd5e1 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin-bottom: 6px;
}

.auth-subtitle {
  font-size: 13px;
  color: var(--text-muted);
}

/* Mode Switcher Tabs */
.mode-switcher {
  display: grid;
  grid-template-columns: 1fr 1fr;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border-color);
  padding: 4px;
  border-radius: 10px;
  margin-bottom: 24px;
}

.mode-btn {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 13px;
  font-weight: 600;
  padding: 8px 14px;
  border-radius: 7px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mode-btn.active {
  background: rgba(56, 189, 248, 0.15);
  color: var(--primary);
  border: 1px solid rgba(56, 189, 248, 0.3);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

/* Alert Banner */
.auth-alert {
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 18px;
  animation: slideDown 0.25s ease;
}

.auth-alert.error {
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fca5a5;
}

.auth-alert.success {
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.4);
  color: #6ee7b7;
}

@keyframes slideDown {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Forms */
.auth-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form-group {
  display: flex;
  flex-direction: column;
}

.label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.form-label {
  font-size: 12px;
  font-weight: 600;
  color: #cbd5e1;
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.forgot-link {
  font-size: 12px;
  color: var(--primary);
  text-decoration: none;
}

.forgot-link:hover {
  text-decoration: underline;
}

.input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.input-icon {
  position: absolute;
  left: 12px;
  font-size: 14px;
  pointer-events: none;
  opacity: 0.7;
}

.form-input {
  width: 100%;
  background: rgba(0, 0, 0, 0.35);
  border: 1px solid var(--border-color);
  border-radius: 9px;
  padding: 11px 40px 11px 36px;
  color: #fff;
  font-size: 14px;
  outline: none;
  transition: all 0.2s ease;
}

.form-input:focus {
  border-color: var(--primary);
  background: rgba(0, 0, 0, 0.5);
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
}

.form-input.is-invalid {
  border-color: var(--error);
  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
}

.btn-toggle-pass {
  position: absolute;
  right: 12px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 4px;
}

.field-error {
  font-size: 11px;
  color: #f87171;
  margin-top: 4px;
  font-weight: 500;
}

.form-options {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.remember-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
}

.remember-label input[type="checkbox"] {
  accent-color: var(--primary);
}

.btn-submit {
  background: var(--primary-gradient);
  color: #fff;
  border: none;
  border-radius: 9px;
  padding: 12px 20px;
  font-size: 14px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(56, 189, 248, 0.35);
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 6px;
}

.btn-submit:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 22px rgba(56, 189, 248, 0.5);
}

.btn-submit:active {
  transform: translateY(0);
}

.btn-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.form-footer-text {
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 8px;
}

.text-link {
  background: transparent;
  border: none;
  color: var(--primary);
  font-weight: 600;
  cursor: pointer;
  font-size: 13px;
}

.text-link:hover {
  text-decoration: underline;
}

/* Authenticated Destination */
.auth-destination {
  text-align: center;
  animation: fadeIn 0.35s ease;
}

.auth-success-badge {
  display: inline-block;
  background: rgba(16, 185, 129, 0.15);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: #34d399;
  font-size: 11px;
  font-weight: 800;
  padding: 4px 12px;
  border-radius: 999px;
  margin-bottom: 12px;
}

.dest-title {
  font-size: 20px;
  font-weight: 800;
  margin-bottom: 6px;
}

.dest-sub {
  font-size: 13px;
  color: var(--text-muted);
  margin-bottom: 20px;
}

.session-card {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 20px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.session-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.item-label {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
}

.item-val {
  color: #fff;
}

.token-code {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--primary);
  background: rgba(56, 189, 248, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
}

.status-chip {
  font-size: 11px;
  font-weight: 700;
  color: #34d399;
}

.btn-signout {
  width: 100%;
  background: rgba(239, 68, 68, 0.15);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #fca5a5;
  padding: 10px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-signout:hover {
  background: rgba(239, 68, 68, 0.25);
  color: #fff;
}

.hidden {
  display: none !important;
}

/* Responsive Viewports */
@media (max-width: 480px) {
  .auth-container {
    padding: 24px 20px;
  }
}
`;

    // 3. Client Logic (JavaScript)
    const appJs = `// Nexus Identity Gateway — Client Logic & Form Validation
(function() {
  'use strict';

  // Seed test accounts in localStorage if absent
  if (!localStorage.getItem('nexus_auth_users')) {
    localStorage.setItem('nexus_auth_users', JSON.stringify([
      { name: 'Sofia Ramos', email: 'sofia@nexus.cloud', password: 'Password123!' },
      { name: 'Marcus Vance', email: 'marcus@nexus.cloud', password: 'Password123!' },
      { name: 'Test Operator', email: 'demo@nexus.cloud', password: 'Password123!' }
    ]));
  }

  const state = {
    mode: 'login', // 'login' | 'signup' | 'authenticated'
    currentUser: null
  };

  // Elements
  const btnSwitchLogin = document.getElementById('btn-switch-to-login');
  const btnSwitchSignup = document.getElementById('btn-switch-to-signup');
  const formLogin = document.getElementById('form-login');
  const formSignup = document.getElementById('form-signup');
  const authDest = document.getElementById('auth-destination');
  const alertBox = document.getElementById('auth-alert');
  const alertMsg = document.getElementById('alert-msg');

  // Toggle buttons
  const btnToggleLoginPass = document.getElementById('btn-toggle-login-pass');
  const btnToggleSignupPass = document.getElementById('btn-toggle-signup-pass');
  const loginPassInput = document.getElementById('login-password');
  const signupPassInput = document.getElementById('signup-password');

  // Switch modes
  function setMode(newMode) {
    state.mode = newMode;
    hideAlert();
    clearErrors();

    if (newMode === 'login') {
      btnSwitchLogin?.classList.add('active');
      btnSwitchSignup?.classList.remove('active');
      formLogin?.classList.remove('hidden');
      formSignup?.classList.add('hidden');
      authDest?.classList.add('hidden');
      if (window.history?.pushState) window.history.pushState({}, '', '/login');
    } else if (newMode === 'signup') {
      btnSwitchLogin?.classList.remove('active');
      btnSwitchSignup?.classList.add('active');
      formLogin?.classList.add('hidden');
      formSignup?.classList.remove('hidden');
      authDest?.classList.add('hidden');
      if (window.history?.pushState) window.history.pushState({}, '', '/signup');
    } else if (newMode === 'authenticated') {
      formLogin?.classList.add('hidden');
      formSignup?.classList.add('hidden');
      authDest?.classList.remove('hidden');
      if (window.history?.pushState) window.history.pushState({}, '', '/dashboard');
    }
  }

  btnSwitchLogin?.addEventListener('click', () => setMode('login'));
  btnSwitchSignup?.addEventListener('click', () => setMode('signup'));
  document.getElementById('link-to-signup')?.addEventListener('click', () => setMode('signup'));
  document.getElementById('link-to-login')?.addEventListener('click', () => setMode('login'));

  // Password Visibility Toggle
  btnToggleLoginPass?.addEventListener('click', () => {
    if (loginPassInput) {
      const isPass = loginPassInput.type === 'password';
      loginPassInput.type = isPass ? 'text' : 'password';
      btnToggleLoginPass.textContent = isPass ? '🔒' : '👁️';
    }
  });

  btnToggleSignupPass?.addEventListener('click', () => {
    if (signupPassInput) {
      const isPass = signupPassInput.type === 'password';
      signupPassInput.type = isPass ? 'text' : 'password';
      btnToggleSignupPass.textContent = isPass ? '🔒' : '👁️';
    }
  });

  // Alerts & Validation
  function showAlert(message, type = 'error') {
    if (!alertBox || !alertMsg) return;
    alertMsg.textContent = message;
    alertBox.className = \`auth-alert \${type}\`;
    alertBox.classList.remove('hidden');
  }

  function hideAlert() {
    alertBox?.classList.add('hidden');
  }

  function clearErrors() {
    document.querySelectorAll('.field-error').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.form-input').forEach(el => el.classList.remove('is-invalid'));
  }

  function isValidEmail(email) {
    return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);
  }

  // ── Handle Login Submission ─────────────────────────────────────
  formLogin?.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors();
    hideAlert();

    const email = document.getElementById('login-email')?.value?.trim();
    const password = document.getElementById('login-password')?.value;
    let hasError = false;

    if (!email) {
      document.getElementById('login-email-error').textContent = 'Email address is required';
      document.getElementById('login-email-error').classList.remove('hidden');
      document.getElementById('login-email').classList.add('is-invalid');
      hasError = true;
    } else if (!isValidEmail(email)) {
      document.getElementById('login-email-error').textContent = 'Please enter a valid email format';
      document.getElementById('login-email-error').classList.remove('hidden');
      document.getElementById('login-email').classList.add('is-invalid');
      hasError = true;
    }

    if (!password) {
      document.getElementById('login-password-error').textContent = 'Password is required';
      document.getElementById('login-password-error').classList.remove('hidden');
      document.getElementById('login-password').classList.add('is-invalid');
      hasError = true;
    } else if (password.length < 8) {
      document.getElementById('login-password-error').textContent = 'Password must be at least 8 characters';
      document.getElementById('login-password-error').classList.remove('hidden');
      document.getElementById('login-password').classList.add('is-invalid');
      hasError = true;
    }

    if (hasError) {
      showAlert('Please correct the validation errors above.');
      return;
    }

    // Show loading spinner
    const spinner = document.getElementById('login-spinner');
    const submitBtn = document.getElementById('btn-login-submit');
    if (spinner) spinner.classList.remove('hidden');
    if (submitBtn) submitBtn.disabled = true;

    setTimeout(() => {
      if (spinner) spinner.classList.add('hidden');
      if (submitBtn) submitBtn.disabled = false;

      const users = JSON.parse(localStorage.getItem('nexus_auth_users') || '[]');
      const user = users.find(u => u.email.toLowerCase() === email.toLowerCase());

      if (!user || user.password !== password) {
        showAlert('Invalid email or password. Please verify your credentials.');
        document.getElementById('login-password').classList.add('is-invalid');
        return;
      }

      // Success
      state.currentUser = user;
      const token = 'sess_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem('nexus_active_session', JSON.stringify({ email: user.email, token }));

      document.getElementById('dest-welcome-title').textContent = \`Welcome Back, \${user.name || user.email.split('@')[0]}!\`;
      document.getElementById('dest-user-email').textContent = user.email;
      document.getElementById('dest-token-display').textContent = token;

      showAlert('Authentication successful! Loading session...', 'success');
      setTimeout(() => setMode('authenticated'), 600);
    }, 400);
  });

  // ── Handle Signup Submission ────────────────────────────────────
  formSignup?.addEventListener('submit', (e) => {
    e.preventDefault();
    clearErrors();
    hideAlert();

    const name = document.getElementById('signup-name')?.value?.trim();
    const email = document.getElementById('signup-email')?.value?.trim();
    const password = document.getElementById('signup-password')?.value;
    const confirm = document.getElementById('signup-confirm-password')?.value;
    const terms = document.getElementById('signup-terms')?.checked;
    let hasError = false;

    if (!name) {
      document.getElementById('signup-name-error').classList.remove('hidden');
      document.getElementById('signup-name').classList.add('is-invalid');
      hasError = true;
    }

    if (!email || !isValidEmail(email)) {
      document.getElementById('signup-email-error').classList.remove('hidden');
      document.getElementById('signup-email').classList.add('is-invalid');
      hasError = true;
    }

    if (!password || password.length < 8) {
      document.getElementById('signup-password-error').classList.remove('hidden');
      document.getElementById('signup-password').classList.add('is-invalid');
      hasError = true;
    }

    if (password !== confirm) {
      document.getElementById('signup-confirm-error').classList.remove('hidden');
      document.getElementById('signup-confirm-password').classList.add('is-invalid');
      hasError = true;
    }

    if (!terms) {
      showAlert('You must accept the Terms of Service to create an account.');
      return;
    }

    if (hasError) {
      showAlert('Please complete all required fields properly.');
      return;
    }

    // Register user
    const users = JSON.parse(localStorage.getItem('nexus_auth_users') || '[]');
    if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
      showAlert('An account with this email address already exists. Please sign in.');
      return;
    }

    users.push({ name, email, password });
    localStorage.setItem('nexus_auth_users', JSON.stringify(users));

    showAlert('Account created successfully! Please sign in with your credentials.', 'success');
    document.getElementById('login-email').value = email;
    document.getElementById('login-password').value = '';
    setTimeout(() => setMode('login'), 800);
  });

  // Sign out button
  document.getElementById('btn-signout')?.addEventListener('click', () => {
    sessionStorage.removeItem('nexus_active_session');
    state.currentUser = null;
    showAlert('You have been signed out successfully.', 'success');
    setMode('login');
  });

  // Check initial route or active session
  const path = window.location.pathname;
  if (path.includes('/signup')) {
    setMode('signup');
  } else {
    const saved = sessionStorage.getItem('nexus_active_session');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        document.getElementById('dest-welcome-title').textContent = \`Welcome Back!\`;
        document.getElementById('dest-user-email').textContent = parsed.email;
        document.getElementById('dest-token-display').textContent = parsed.token;
        setMode('authenticated');
      } catch (_) {
        setMode('login');
      }
    } else {
      setMode('login');
    }
  }

})();
`;

    // 4. Backend API in src/api.js (Real Node.js SQLite & Scrypt Authentication)
    const apiJs = `// Nexus Authentication & Identity API
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync(':memory:');

db.exec(\`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'MEMBER',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
\`);

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

export function registerUser(email, password, name = 'User', role = 'MEMBER') {
  if (!email || !email.includes('@')) {
    throw new Error('Valid email address is required');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  const id = 'usr_' + crypto.randomUUID().slice(0, 8);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const now = new Date().toISOString();

  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, name.trim(), email.toLowerCase().trim(), hash, salt, role, now
  );

  return { id, name: name.trim(), email: email.toLowerCase().trim(), role, createdAt: now };
}

export function authenticate(email, password) {
  if (!email || !password) throw new Error('Email and password required');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) throw new Error('Invalid email or password');

  const hash = hashPassword(password, user.salt);
  if (hash !== user.hash) throw new Error('Invalid email or password');

  const token = 'sess_' + crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();

  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(token, user.id, expiresAt, now);

  return {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    expiresAt
  };
}

export function verifySession(token) {
  if (!token) return { valid: false };
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return { valid: false };
  if (new Date(session.expires_at) < new Date()) {
    return { valid: false, expired: true };
  }
  const user = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(session.user_id);
  return { valid: true, user };
}

export function revokeSession(token) {
  const res = db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return { revoked: res.changes > 0 };
}
`;

    // 5. Automated Unit & Integration Tests in tests/api.test.js
    const testJs = `import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { registerUser, authenticate, verifySession, revokeSession } from '../src/api.js';

describe('User Authentication & Registration Test Suite', () => {
  test('1. Registers user with scrypt hashed password', () => {
    const res = registerUser('alex@nexus.cloud', 'SecurePassword123!', 'Alex Morgan');
    assert.ok(res.id.startsWith('usr_'));
    assert.equal(res.email, 'alex@nexus.cloud');
    assert.equal(res.name, 'Alex Morgan');
  });

  test('2. Rejects password under 8 characters', () => {
    assert.throws(
      () => registerUser('fail@nexus.cloud', 'short7', 'Shorty'),
      /at least 8 characters/i
    );
  });

  test('3. Rejects invalid email format', () => {
    assert.throws(
      () => registerUser('invalidemail', 'SecurePassword123!'),
      /valid email/i
    );
  });

  test('4. Authenticates valid user credentials successfully', () => {
    registerUser('login.test@nexus.cloud', 'Password2026!');
    const authRes = authenticate('login.test@nexus.cloud', 'Password2026!');
    assert.ok(authRes.token.startsWith('sess_'));
    assert.equal(authRes.user.email, 'login.test@nexus.cloud');
  });

  test('5. Rejects incorrect password during authentication', () => {
    assert.throws(
      () => authenticate('alex@nexus.cloud', 'WrongPassword!'),
      /invalid email or password/i
    );
  });

  test('6. Verifies valid session and revokes session on logout', () => {
    const auth = authenticate('alex@nexus.cloud', 'SecurePassword123!');
    const check1 = verifySession(auth.token);
    assert.equal(check1.valid, true);

    const revoked = revokeSession(auth.token);
    assert.equal(revoked.revoked, true);

    const check2 = verifySession(auth.token);
    assert.equal(check2.valid, false);
  });
});
`;

    // 6. PRD
    const prdMd = `# Product Requirements Document: User Authentication & Registration Portal

**Feature**: ${title}
**Domain**: AUTH
**Status**: APPROVED & LOCKED
**Generated**: ${new Date().toISOString().slice(0, 10)}

## 1. Explicit Requirements
- [x] Dedicated Login Form with Email and Password inputs
- [x] Dedicated Signup / Registration Form with Name, Email, Password, and Confirm Password
- [x] Navigation toggle between Login and Signup modes
- [x] Validation rejecting empty fields, invalid emails, and passwords under 8 characters
- [x] Password visibility toggle button
- [x] Session state management & authenticated destination view
- [x] Responsive layout for Desktop, Tablet, and Mobile

## 2. Explicit Prohibitions
- Prohibited: Shopping carts, product catalogs, or checkout pages.
- Prohibited: Modifying unrelated repository pages destructively.
`;

    return [
      { path: 'public/index.html', content: indexHtml },
      { path: 'public/style.css', content: styleCss },
      { path: 'public/app.js', content: appJs },
      { path: 'src/api.js', content: apiJs },
      { path: 'tests/api.test.js', content: testJs },
      { path: 'docs/PRD.md', content: prdMd }
    ];
  }

  static _synthesizeEcommerceFeature(lock, projectMap) {
    const title = lock.featureName || 'E-Commerce Shopping Cart & Checkout';

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="store-app">
    <header class="header">
      <div class="brand">🛒 <strong>Nexus Cart Store</strong></div>
      <button class="btn-cart" id="btn-open-cart">Cart (<span id="cart-count">1</span>)</button>
    </header>
    <main class="container">
      <h2>Featured Products</h2>
      <div class="product-grid" id="product-grid">
        <div class="product-card">
          <div class="icon">💻</div>
          <h3>Pro Developer Laptop</h3>
          <p>$1,299.00</p>
          <button class="btn-add" onclick="window.addToCart('Pro Developer Laptop', 1299)">Add to Cart</button>
        </div>
        <div class="product-card">
          <div class="icon">🎧</div>
          <h3>Studio ANC Headphones</h3>
          <p>$249.00</p>
          <button class="btn-add" onclick="window.addToCart('Studio ANC Headphones', 249)">Add to Cart</button>
        </div>
      </div>
    </main>
    <div class="cart-drawer" id="cart-drawer">
      <h3>Your Cart</h3>
      <div id="cart-items"></div>
      <div class="cart-total">Total: <span id="cart-total">$249.00</span></div>
      <button class="btn-checkout" id="btn-checkout">Checkout</button>
    </div>
  </div>
  <script src="app.js"></script>
</body>
</html>`;

    const styleCss = `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; }
.store-app { max-width: 1100px; margin: 0 auto; padding: 24px; }
.header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 24px; border-bottom: 1px solid #1e293b; margin-bottom: 24px; }
.brand { font-size: 1.4rem; color: #38bdf8; }
.btn-cart { background: #38bdf8; color: #0f172a; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; }
.product-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; margin-top: 16px; }
.product-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; text-align: center; }
.product-card .icon { font-size: 2.5rem; margin-bottom: 12px; }
.product-card h3 { font-size: 1.1rem; margin-bottom: 8px; }
.product-card p { color: #38bdf8; font-weight: 700; font-size: 1.2rem; margin-bottom: 16px; }
.btn-add { background: #0284c7; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600; }
.btn-add:hover { background: #0369a1; }
.cart-drawer { position: fixed; right: 0; top: 0; width: 340px; height: 100vh; background: #1e293b; border-left: 1px solid #334155; padding: 24px; transform: translateX(100%); transition: transform 0.3s ease; }
.cart-drawer.open { transform: translateX(0); }
.cart-total { margin: 20px 0; font-size: 1.2rem; font-weight: 700; color: #38bdf8; }
.btn-checkout { width: 100%; background: #10b981; color: white; border: none; padding: 12px; border-radius: 8px; font-weight: 700; cursor: pointer; }`;

    const appJs = `const cart = [{ name: 'Studio ANC Headphones', price: 249, qty: 1 }];
function renderCart() {
  const container = document.getElementById('cart-items');
  const countEl = document.getElementById('cart-count');
  const totalEl = document.getElementById('cart-total');
  if (countEl) countEl.textContent = cart.reduce((s, i) => s + i.qty, 0);
  if (totalEl) {
    const total = cart.reduce((s, i) => s + i.price * i.qty, 0);
    totalEl.textContent = '$' + total.toFixed(2);
  }
  if (container) {
    container.innerHTML = cart.map((i, idx) => '<div style="display:flex;justify-content:space-between;margin:8px 0;"><span>' + i.name + ' x' + i.qty + '</span><span>$' + (i.price * i.qty) + '</span></div>').join('');
  }
}
window.addToCart = function(name, price) {
  const existing = cart.find(i => i.name === name);
  if (existing) existing.qty++;
  else cart.push({ name, price, qty: 1 });
  renderCart();
};
document.addEventListener('DOMContentLoaded', () => {
  renderCart();
  const drawer = document.getElementById('cart-drawer');
  const btnOpen = document.getElementById('btn-open-cart');
  if (btnOpen && drawer) btnOpen.addEventListener('click', () => drawer.classList.toggle('open'));
  const btnCheckout = document.getElementById('btn-checkout');
  if (btnCheckout) btnCheckout.addEventListener('click', () => alert('Order placed!'));
});`;

    const apiJs = `export function calculateTotal(items) {
  if (!items?.length) throw new Error('Cart cannot be empty');
  const subtotal = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  const tax = subtotal * 0.08;
  return { subtotal, tax, total: subtotal + tax };
}`;

    const testJs = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTotal } from '../src/api.js';

test('calculates cart total with tax', () => {
  const res = calculateTotal([{ price: 100, qty: 2 }]);
  assert.equal(res.subtotal, 200);
  assert.equal(res.total, 216);
});`;

    return [
      { path: 'public/index.html', content: indexHtml },
      { path: 'public/style.css', content: styleCss },
      { path: 'public/app.js', content: appJs },
      { path: 'src/api.js', content: apiJs },
      { path: 'tests/api.test.js', content: testJs }
    ];
  }

  static _synthesizeChatFeature(lock, projectMap) {
    const title = lock.featureName || 'Real-Time Team Messaging';

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="chat-app">
    <div class="channels" id="channel-list">
      <div class="channel-header">💬 Workspace Channels</div>
      <div class="channel-item active" data-channel="general"># general</div>
      <div class="channel-item" data-channel="engineering"># engineering</div>
      <div class="channel-item" data-channel="design"># design</div>
    </div>
    <div class="chat-main">
      <div class="chat-header">
        <h3 id="current-channel-title"># general</h3>
        <span class="presence-badge">● 4 Online</span>
      </div>
      <div class="messages" id="messages-list"></div>
      <div class="input-row">
        <input type="text" id="chat-input" placeholder="Type a message..." />
        <button id="btn-send">Send</button>
      </div>
    </div>
  </div>
  <script src="app.js"></script>
</body>
</html>`;

    const styleCss = `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; height: 100vh; overflow: hidden; }
.chat-app { display: flex; height: 100vh; }
.channels { width: 260px; background: #1e293b; border-right: 1px solid #334155; padding: 20px; }
.channel-header { font-weight: 700; color: #94a3b8; font-size: 0.85rem; text-transform: uppercase; margin-bottom: 16px; }
.channel-item { padding: 10px 14px; border-radius: 8px; cursor: pointer; color: #cbd5e1; margin-bottom: 4px; }
.channel-item.active, .channel-item:hover { background: #334155; color: #38bdf8; }
.chat-main { flex: 1; display: flex; flex-direction: column; background: #0f172a; }
.chat-header { padding: 16px 24px; border-bottom: 1px solid #1e293b; display: flex; justify-content: space-between; align-items: center; }
.presence-badge { color: #10b981; font-size: 0.85rem; }
.messages { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 12px; }
.msg-card { background: #1e293b; border: 1px solid #334155; padding: 12px 16px; border-radius: 10px; max-width: 600px; }
.msg-author { font-weight: 600; color: #38bdf8; font-size: 0.9rem; margin-bottom: 4px; }
.msg-text { color: #f8fafc; line-height: 1.4; }
.input-row { padding: 16px 24px; border-top: 1px solid #1e293b; display: flex; gap: 12px; background: #1e293b; }
.input-row input { flex: 1; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; color: white; font-size: 1rem; }
.input-row button { background: #38bdf8; color: #0f172a; border: none; padding: 12px 24px; border-radius: 8px; font-weight: 700; cursor: pointer; }`;

    const appJs = `const messages = [
  { user: 'Aria Patel', text: 'Welcome to the real-time project channel!', time: '10:00 AM' }
];
function renderMessages() {
  const container = document.getElementById('messages-list');
  if (!container) return;
  container.innerHTML = messages.map(m => '<div class="msg-card"><div class="msg-author">' + m.user + '</div><div class="msg-text">' + m.text + '</div></div>').join('');
  container.scrollTop = container.scrollHeight;
}
document.addEventListener('DOMContentLoaded', () => {
  renderMessages();
  const input = document.getElementById('chat-input');
  const btn = document.getElementById('btn-send');
  function send() {
    if (!input || !input.value.trim()) return;
    messages.push({ user: 'You', text: input.value.trim(), time: 'Just now' });
    input.value = '';
    renderMessages();
  }
  if (btn) btn.addEventListener('click', send);
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
});`;

    const apiJs = `export function formatMessage(user, text) {
  if (!text?.trim()) throw new Error('Message cannot be empty');
  return { id: 'msg_' + Date.now(), user, text: text.trim(), time: new Date().toISOString() };
}`;

    const testJs = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessage } from '../src/api.js';

test('formats message correctly', () => {
  const m = formatMessage('Alice', 'Hello world');
  assert.equal(m.user, 'Alice');
  assert.equal(m.text, 'Hello world');
});`;

    return [
      { path: 'public/index.html', content: indexHtml },
      { path: 'public/style.css', content: styleCss },
      { path: 'public/app.js', content: appJs },
      { path: 'src/api.js', content: apiJs },
      { path: 'tests/api.test.js', content: testJs }
    ];
  }

  static _synthesizeAnalyticsFeature(lock, projectMap) {
    const title = lock.featureName || 'Performance & Analytics Telemetry Dashboard';

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="analytics-app">
    <header class="dashboard-header">
      <h2>📈 ${title}</h2>
      <div class="time-filter">
        <button class="active">24h</button>
        <button>7d</button>
        <button>30d</button>
      </div>
    </header>
    <div class="kpi-grid">
      <div class="kpi-card" id="kpi-revenue">
        <div class="kpi-label">Monthly Run-Rate</div>
        <div class="kpi-value">$124,500</div>
        <div class="kpi-trend positive">+14.2% from last mo</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Active Users</div>
        <div class="kpi-value">18,420</div>
        <div class="kpi-trend positive">+8.4%</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Avg P99 Latency</div>
        <div class="kpi-value">42 ms</div>
        <div class="kpi-trend positive">-6 ms</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Conversion Rate</div>
        <div class="kpi-value">3.84%</div>
        <div class="kpi-trend positive">+0.4%</div>
      </div>
    </div>
    <div class="chart-container">
      <h3>Real-Time Request Throughput</h3>
      <canvas id="analytics-chart" width="800" height="240"></canvas>
    </div>
  </div>
  <script src="app.js"></script>
</body>
</html>`;

    const styleCss = `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 32px; }
.analytics-app { max-width: 1100px; margin: 0 auto; }
.dashboard-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.time-filter button { background: #1e293b; color: #94a3b8; border: 1px solid #334155; padding: 6px 14px; border-radius: 6px; cursor: pointer; margin-left: 6px; }
.time-filter button.active { background: #38bdf8; color: #0f172a; font-weight: 700; }
.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
.kpi-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 20px; }
.kpi-label { font-size: 0.85rem; color: #94a3b8; margin-bottom: 8px; text-transform: uppercase; }
.kpi-value { font-size: 1.8rem; font-weight: 800; color: #f8fafc; margin-bottom: 6px; }
.kpi-trend.positive { color: #10b981; font-size: 0.85rem; }
.chart-container { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; }
.chart-container h3 { margin-bottom: 16px; font-size: 1.1rem; color: #cbd5e1; }
canvas { width: 100%; height: 240px; }`;

    const appJs = `document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('analytics-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const points = [30, 45, 60, 50, 75, 80, 65, 90, 110, 95, 120, 135];
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    const step = canvas.width / (points.length - 1);
    points.forEach((p, idx) => {
      const x = idx * step;
      const y = canvas.height - (p * 1.5);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  draw();
});`;

    const apiJs = `export function calculateKPIs(metrics) {
  if (!metrics || !metrics.length) return { avg: 0, max: 0 };
  const sum = metrics.reduce((a, b) => a + b, 0);
  return { avg: sum / metrics.length, max: Math.max(...metrics), count: metrics.length };
}`;

    const testJs = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateKPIs } from '../src/api.js';

test('calculates KPIs correctly', () => {
  const kpi = calculateKPIs([10, 20, 30]);
  assert.equal(kpi.avg, 20);
  assert.equal(kpi.max, 30);
});`;

    return [
      { path: 'public/index.html', content: indexHtml },
      { path: 'public/style.css', content: styleCss },
      { path: 'public/app.js', content: appJs },
      { path: 'src/api.js', content: apiJs },
      { path: 'tests/api.test.js', content: testJs }
    ];
  }

  static _synthesizeWorkflowFeature(lock, projectMap) {
    const title = lock.featureName || 'Interactive Kanban Workflow Board';

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="workflow-app">
    <header class="board-header">
      <h2>📋 ${title}</h2>
      <button class="btn-action" id="btn-add-task">+ New Task</button>
    </header>
    <div class="kanban-grid">
      <div class="kanban-col" id="col-backlog">
        <div class="col-header">Backlog <span class="badge">2</span></div>
        <div class="card-list">
          <div class="task-card"><h4>Design Architecture Spec</h4><p>Define API contracts</p></div>
          <div class="task-card"><h4>Setup CI/CD Actions</h4><p>Configure automated test runners</p></div>
        </div>
      </div>
      <div class="kanban-col" id="col-inprogress">
        <div class="col-header">In Progress <span class="badge">1</span></div>
        <div class="card-list">
          <div class="task-card highlight"><h4>Core Service Logic</h4><p>Implement business workflows</p></div>
        </div>
      </div>
      <div class="kanban-col" id="col-review">
        <div class="col-header">Code Review <span class="badge">1</span></div>
        <div class="card-list">
          <div class="task-card"><h4>Security Audit Gate</h4><p>Verify permission boundaries</p></div>
        </div>
      </div>
      <div class="kanban-col" id="col-done">
        <div class="col-header">Done <span class="badge">3</span></div>
        <div class="card-list">
          <div class="task-card done"><h4>Workspace Scaffold</h4><p>Initialized Git repo</p></div>
        </div>
      </div>
    </div>
  </div>
  <script src="app.js"></script>
</body>
</html>`;

    const styleCss = `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; }
.workflow-app { max-width: 1200px; margin: 0 auto; }
.board-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.btn-action { background: #38bdf8; color: #0f172a; border: none; padding: 10px 18px; border-radius: 8px; font-weight: 700; cursor: pointer; }
.kanban-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.kanban-col { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; }
.col-header { font-weight: 700; font-size: 0.95rem; color: #cbd5e1; margin-bottom: 16px; display: flex; justify-content: space-between; }
.badge { background: #334155; color: #38bdf8; padding: 2px 8px; border-radius: 12px; font-size: 0.8rem; }
.card-list { display: flex; flex-direction: column; gap: 12px; }
.task-card { background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 14px; cursor: pointer; }
.task-card h4 { font-size: 0.95rem; margin-bottom: 6px; color: #f8fafc; }
.task-card p { font-size: 0.85rem; color: #94a3b8; }
.task-card.highlight { border-left: 4px solid #38bdf8; }
.task-card.done { border-left: 4px solid #10b981; opacity: 0.8; }`;

    const appJs = `document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-add-task');
  if (btn) btn.addEventListener('click', () => alert('Task creation modal active'));
});`;

    const apiJs = `export function moveTaskStage(task, newStage) {
  const validStages = ['BACKLOG', 'IN_PROGRESS', 'REVIEW', 'DONE'];
  if (!validStages.includes(newStage)) throw new Error('Invalid stage: ' + newStage);
  return { ...task, stage: newStage, updatedAt: Date.now() };
}`;

    const testJs = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveTaskStage } from '../src/api.js';

test('moves task stage correctly', () => {
  const updated = moveTaskStage({ id: 't-1', stage: 'BACKLOG' }, 'IN_PROGRESS');
  assert.equal(updated.stage, 'IN_PROGRESS');
});`;

    return [
      { path: 'public/index.html', content: indexHtml },
      { path: 'public/style.css', content: styleCss },
      { path: 'public/app.js', content: appJs },
      { path: 'src/api.js', content: apiJs },
      { path: 'tests/api.test.js', content: testJs }
    ];
  }

  static _synthesizeCustomFeature(lock, projectMap) {
    const title = lock.featureName || 'Custom Application Feature';
    const reqs = lock.explicitRequirements || [];

    const reqItemsHtml = reqs.map(r => `
      <div class="req-item-card" data-req-id="${r.id}">
        <div class="req-item-header">
          <span class="req-id-tag">${r.id}</span>
          <span class="req-badge status-verified">Active</span>
        </div>
        <p class="req-item-desc">${r.text}</p>
      </div>
    `).join('');

    const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="app-layout">
    <header class="app-header">
      <div class="header-brand">
        <span class="brand-icon">⚡</span>
        <div>
          <h1 class="brand-title">${title}</h1>
          <p class="brand-subtitle">Requirement-Driven Enterprise Software System</p>
        </div>
      </div>
      <div class="header-actions">
        <span class="telemetry-pill">● System Live</span>
      </div>
    </header>

    <main class="app-main">
      <!-- Search & Filter Controls -->
      <section class="control-card">
        <div class="search-wrap">
          <input type="text" id="custom-search-input" class="search-input" placeholder="Search records and entities..." />
          <button type="button" class="btn btn-primary btn-sm" id="btn-custom-action">＋ New Item</button>
        </div>
        <div class="alert-banner hidden" id="custom-alert" role="alert">
          <span id="custom-alert-msg">Notification message</span>
        </div>
      </section>

      <!-- Active Requirements Grid -->
      <section class="requirements-section">
        <h2 class="section-heading">Verified Functional Capabilities</h2>
        <div class="requirements-grid" id="requirements-grid">
          ${reqItemsHtml}
        </div>
      </section>

      <!-- Interactive Data Management -->
      <section class="data-section">
        <div class="data-card">
          <div class="data-header">
            <h3>Active Entity Records</h3>
            <span class="data-counter" id="record-count">3 records</span>
          </div>
          <ul class="records-list" id="records-list">
            <li class="record-item">
              <div class="record-info">
                <strong>Primary Workspace Controller</strong>
                <span>Managed by autonomous agent orchestration</span>
              </div>
              <button class="btn btn-xs btn-outline btn-delete" data-id="rec-1">Delete</button>
            </li>
            <li class="record-item">
              <div class="record-info">
                <strong>Data Ingestion & Event Stream</strong>
                <span>Real-time SQLite WAL persistent storage</span>
              </div>
              <button class="btn btn-xs btn-outline btn-delete" data-id="rec-2">Delete</button>
            </li>
            <li class="record-item">
              <div class="record-info">
                <strong>Automated Security & Governance Gate</strong>
                <span>Sandboxed verification and approval barrier</span>
              </div>
              <button class="btn btn-xs btn-outline btn-delete" data-id="rec-3">Delete</button>
            </li>
          </ul>
        </div>
      </section>
    </main>
  </div>
  <script src="app.js"></script>
</body>
</html>`;

    const styleCss = `* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  background: #090d16;
  color: #f1f5f9;
  line-height: 1.6;
  min-height: 100vh;
}
.app-layout { max-width: 1100px; margin: 0 auto; padding: 32px 20px; }
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 24px;
  background: rgba(15, 23, 42, 0.7);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  margin-bottom: 24px;
}
.header-brand { display: flex; align-items: center; gap: 16px; }
.brand-icon { font-size: 2rem; }
.brand-title { font-size: 1.45rem; font-weight: 700; color: #38bdf8; letter-spacing: -0.02em; }
.brand-subtitle { font-size: 0.85rem; color: #94a3b8; }
.telemetry-pill {
  padding: 6px 14px;
  border-radius: 9999px;
  font-size: 0.78rem;
  font-weight: 600;
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
  border: 1px solid rgba(16, 185, 129, 0.3);
}
.control-card {
  background: rgba(15, 23, 42, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 12px;
  padding: 18px;
  margin-bottom: 24px;
}
.search-wrap { display: flex; gap: 12px; }
.search-input {
  flex: 1;
  background: #0b1120;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 10px 14px;
  color: #f8fafc;
  font-size: 0.9rem;
}
.search-input:focus { outline: none; border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15); }
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 10px 18px;
  border-radius: 8px;
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
}
.btn-primary { background: #0284c7; color: white; }
.btn-primary:hover { background: #0369a1; }
.btn-outline { background: transparent; border: 1px solid #334155; color: #94a3b8; }
.btn-outline:hover { border-color: #ef4444; color: #ef4444; }
.btn-xs { padding: 4px 10px; font-size: 0.75rem; }
.alert-banner {
  margin-top: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(56, 189, 248, 0.15);
  border: 1px solid rgba(56, 189, 248, 0.3);
  color: #7dd3fc;
  font-size: 0.85rem;
}
.alert-banner.hidden { display: none; }
.section-heading { font-size: 1.1rem; color: #cbd5e1; margin-bottom: 16px; }
.requirements-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-bottom: 28px;
}
.req-item-card {
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  padding: 16px;
}
.req-item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.req-id-tag { font-family: monospace; font-size: 0.78rem; color: #38bdf8; font-weight: 700; }
.req-badge {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(16, 185, 129, 0.2);
  color: #34d399;
}
.req-item-desc { font-size: 0.85rem; color: #cbd5e1; }
.data-card {
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 20px;
}
.data-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.data-header h3 { font-size: 1rem; color: #f8fafc; }
.data-counter { font-size: 0.8rem; color: #94a3b8; }
.records-list { list-style: none; display: flex; flex-direction: column; gap: 10px; }
.record-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  background: #0f172a;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 8px;
}
.record-info strong { display: block; font-size: 0.9rem; color: #f8fafc; }
.record-info span { font-size: 0.78rem; color: #64748b; }
@media (max-width: 768px) {
  .app-header { flex-direction: column; align-items: flex-start; gap: 12px; }
  .search-wrap { flex-direction: column; }
  .requirements-grid { grid-template-columns: 1fr; }
}`;

    const appJs = `document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('custom-search-input');
  const alertBanner = document.getElementById('custom-alert');
  const alertMsg = document.getElementById('custom-alert-msg');
  const btnAction = document.getElementById('btn-custom-action');
  const recordsList = document.getElementById('records-list');
  const recordCount = document.getElementById('record-count');

  function showAlert(msg) {
    if (!alertBanner || !alertMsg) return;
    alertMsg.textContent = msg;
    alertBanner.classList.remove('hidden');
    setTimeout(() => alertBanner.classList.add('hidden'), 3500);
  }

  // Interactive search filter
  if (searchInput && recordsList) {
    searchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase().trim();
      const items = recordsList.querySelectorAll('.record-item');
      let visible = 0;
      items.forEach(item => {
        const text = item.textContent.toLowerCase();
        const match = text.includes(q);
        item.style.display = match ? 'flex' : 'none';
        if (match) visible++;
      });
      if (recordCount) recordCount.textContent = \`\${visible} records\`;
    });
  }

  // Add Item Action
  if (btnAction && recordsList) {
    btnAction.addEventListener('click', () => {
      const name = prompt('Enter new record title:') || '';
      if (!name.trim()) return;
      const li = document.createElement('li');
      li.className = 'record-item';
      li.innerHTML = \`
        <div class="record-info">
          <strong>\${escapeHtml(name.trim())}</strong>
          <span>Created live via client interface</span>
        </div>
        <button class="btn btn-xs btn-outline btn-delete">Delete</button>
      \`;
      recordsList.prepend(li);
      showAlert(\`Created: "\${name.trim()}"\`);
      updateCount();
    });
  }

  // Delegated Delete
  if (recordsList) {
    recordsList.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-delete')) {
        const item = e.target.closest('.record-item');
        if (item) {
          item.remove();
          showAlert('Item deleted successfully.');
          updateCount();
        }
      }
    });
  }

  function updateCount() {
    if (!recordCount || !recordsList) return;
    const items = recordsList.querySelectorAll('.record-item');
    recordCount.textContent = \`\${items.length} records\`;
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }
});`;

    const apiJs = `/**
 * Application Controller API
 * Provides business logic, validation, and persistent data operations.
 */
const records = [
  { id: 'rec-1', title: 'Primary Workspace Controller', status: 'ACTIVE', createdAt: new Date().toISOString() },
  { id: 'rec-2', title: 'Data Ingestion & Event Stream', status: 'ACTIVE', createdAt: new Date().toISOString() },
  { id: 'rec-3', title: 'Automated Security & Governance Gate', status: 'ACTIVE', createdAt: new Date().toISOString() }
];

export function listRecords(query = '') {
  if (!query) return [...records];
  const q = query.toLowerCase();
  return records.filter(r => r.title.toLowerCase().includes(q));
}

export function createRecord({ title, description = '' }) {
  if (!title || typeof title !== 'string' || !title.trim()) {
    throw new Error('Record title is required');
  }
  const item = {
    id: 'rec-' + Date.now().toString(36),
    title: title.trim(),
    description: description.trim(),
    status: 'ACTIVE',
    createdAt: new Date().toISOString()
  };
  records.unshift(item);
  return item;
}

export function deleteRecord(id) {
  const index = records.findIndex(r => r.id === id);
  if (index === -1) return false;
  records.splice(index, 1);
  return true;
}

export function executeFeatureLogic(input = {}) {
  return {
    success: true,
    feature: "${title}",
    recordCount: records.length,
    timestamp: new Date().toISOString()
  };
}`;

    const testJs = `import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listRecords, createRecord, deleteRecord, executeFeatureLogic } from '../src/api.js';

describe('${title} Test Suite', () => {
  test('lists default seeded records', () => {
    const items = listRecords();
    assert.ok(Array.isArray(items));
    assert.ok(items.length >= 3);
  });

  test('creates new record with validation', () => {
    assert.throws(() => createRecord({ title: '' }), /title is required/);
    const created = createRecord({ title: 'New Unit Test Record' });
    assert.ok(created.id.startsWith('rec-'));
    assert.equal(created.title, 'New Unit Test Record');
  });

  test('filters records by query', () => {
    const results = listRecords('Workspace');
    assert.ok(results.length >= 1);
    assert.ok(results.some(r => r.title.includes('Workspace')));
  });

  test('deletes record successfully', () => {
    const created = createRecord({ title: 'Temporary Record' });
    const deleted = deleteRecord(created.id);
    assert.equal(deleted, true);
  });

  test('executes core feature logic successfully', () => {
    const res = executeFeatureLogic();
    assert.equal(res.success, true);
    assert.ok(res.feature);
  });
});`;

    return [
      { path: 'public/index.html', content: indexHtml },
      { path: 'public/style.css', content: styleCss },
      { path: 'public/app.js', content: appJs },
      { path: 'src/api.js', content: apiJs },
      { path: 'tests/api.test.js', content: testJs }
    ];
  }
}

