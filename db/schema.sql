-- Mess Manager sync server schema (MySQL 8).
--
-- Mirrors the Flutter app's Drift schema (v4) for every synced table, plus
-- the auth/online-only tables the app doesn't have. The phone never talks
-- to this database directly -- only through the API.
--
-- Conventions:
--   * All ids are CHAR(36) UUIDs, generated client-side (the app already
--     generates uuid v4 for every row) so offline-created rows never
--     collide once synced.
--   * `updated_at` is BIGINT epoch-milliseconds on every synced table,
--     matching the app exactly -- this is the last-write-wins sync key.
--   * Money is always BIGINT paisa. Never FLOAT/DECIMAL for currency.

SET NAMES utf8mb4;

-- ===================== Auth / online-only ==================================

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) PRIMARY KEY,
  google_sub VARCHAR(64) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL,
  name VARCHAR(255) NULL,
  photo_url VARCHAR(512) NULL,
  created_at BIGINT NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL, -- sha256 hex of the refresh token; never store it raw
  expires_at BIGINT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_refresh_user (user_id)
) ENGINE=InnoDB;

-- Master Admin allowlist. Seeded from server env (MASTER_ADMIN_EMAILS), not
-- editable through any API route -- deliberately out of band.
CREATE TABLE IF NOT EXISTS master_admins (
  email VARCHAR(255) PRIMARY KEY
) ENGINE=InnoDB;

-- ===================== Synced mess data =====================================

CREATE TABLE IF NOT EXISTS `groups` (
  id CHAR(36) PRIMARY KEY,
  owner_user_id CHAR(36) NULL, -- the App Admin's account, once claimed
  invite_code CHAR(9) NULL UNIQUE, -- 'MESS-XXXX' style, set when brought online
  name VARCHAR(255) NOT NULL,
  type VARCHAR(16) NOT NULL DEFAULT 'mess',
  currency_symbol VARCHAR(8) NOT NULL DEFAULT '৳',
  month_start_day INT NOT NULL DEFAULT 1,
  meal_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  meal_ledger_separate BOOLEAN NOT NULL DEFAULT FALSE,
  default_non_voter_policy VARCHAR(16) NOT NULL DEFAULT 'routine',
  -- Minutes before a poll closes that every member's device fires the
  -- "vote now" reminder (mess-wide, App-Admin set; 0 = off).
  poll_reminder_minutes INT NOT NULL DEFAULT 30,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  -- Subscription / Master Admin control (user decision: buyer pays the
  -- user directly, Master extends `paid_until` manually via the web
  -- dashboard; an expired mess is flipped read-only server-side).
  status ENUM('active', 'expired', 'disabled') NOT NULL DEFAULT 'active',
  paid_until DATE NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_groups_owner (owner_user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS members (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL, -- linked once this person joins by invite code and signs in
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(32) NULL,
  photo_path VARCHAR(512) NULL,
  join_date BIGINT NOT NULL,
  leave_date BIGINT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  role ENUM('appAdmin', 'subAdmin', 'member') NOT NULL DEFAULT 'member',
  permissions VARCHAR(255) NOT NULL DEFAULT '', -- comma-separated MemberPermission keys
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_members_group (group_id),
  INDEX idx_members_user (user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS categories (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NULL, -- null = global default category
  name VARCHAR(255) NOT NULL,
  default_key VARCHAR(64) NULL,
  is_meal_category BOOLEAN NOT NULL DEFAULT FALSE,
  icon VARCHAR(64) NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  INDEX idx_categories_group (group_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS expenses (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  amount_paisa BIGINT NOT NULL,
  date BIGINT NOT NULL,
  category_id CHAR(36) NOT NULL,
  note TEXT NULL,
  receipt_path VARCHAR(512) NULL,
  is_recurring_instance BOOLEAN NOT NULL DEFAULT FALSE,
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES categories(id),
  INDEX idx_expenses_group (group_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS expense_payers (
  expense_id CHAR(36) NOT NULL,
  member_id CHAR(36) NOT NULL,
  amount_paid_paisa BIGINT NOT NULL,
  PRIMARY KEY (expense_id, member_id),
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS expense_splits (
  expense_id CHAR(36) NOT NULL,
  member_id CHAR(36) NOT NULL,
  amount_paisa BIGINT NOT NULL,
  split_type VARCHAR(16) NOT NULL,
  PRIMARY KEY (expense_id, member_id),
  FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS meals (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  member_id CHAR(36) NOT NULL,
  date BIGINT NOT NULL,
  count DOUBLE NOT NULL DEFAULT 0,
  guest_count DOUBLE NOT NULL DEFAULT 0,
  slots_json TEXT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id),
  INDEX idx_meals_group_date (group_id, date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS deposits (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  member_id CHAR(36) NOT NULL,
  amount_paisa BIGINT NOT NULL,
  date BIGINT NOT NULL,
  note TEXT NULL,
  purpose VARCHAR(16) NOT NULL DEFAULT 'general',
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id),
  INDEX idx_deposits_group (group_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS settlements (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  from_member_id CHAR(36) NOT NULL,
  to_member_id CHAR(36) NOT NULL,
  amount_paisa BIGINT NOT NULL,
  date BIGINT NOT NULL,
  method VARCHAR(64) NULL,
  note TEXT NULL,
  purpose VARCHAR(16) NOT NULL DEFAULT 'general',
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (from_member_id) REFERENCES members(id),
  FOREIGN KEY (to_member_id) REFERENCES members(id),
  INDEX idx_settlements_group (group_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS months (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  `year_month` CHAR(7) NOT NULL, -- 'YYYY-MM'
  closed_at BIGINT NULL,
  meal_rate_paisa BIGINT NULL,
  snapshot_json LONGTEXT NULL,
  meal_closed_at BIGINT NULL,
  meal_snapshot_json LONGTEXT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  UNIQUE KEY uq_months_group_month (group_id, `year_month`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS recurring_rules (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  template_json TEXT NOT NULL,
  day_of_month INT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  INDEX idx_recurring_group (group_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS meal_slots (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  name VARCHAR(64) NOT NULL,
  default_key VARCHAR(32) NULL,
  weight DOUBLE NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  INDEX idx_meal_slots_group (group_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS member_meal_routines (
  id CHAR(36) PRIMARY KEY,
  member_id CHAR(36) NOT NULL,
  slot_id CHAR(36) NOT NULL,
  weekday INT NULL, -- 1=Mon..7=Sun, NULL=every day
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  FOREIGN KEY (slot_id) REFERENCES meal_slots(id) ON DELETE CASCADE,
  INDEX idx_routines_member (member_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS meal_leaves (
  id CHAR(36) PRIMARY KEY,
  member_id CHAR(36) NOT NULL,
  from_date BIGINT NOT NULL,
  to_date BIGINT NOT NULL,
  note TEXT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  INDEX idx_leaves_member (member_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bazar_duties (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  member_id CHAR(36) NOT NULL,
  date BIGINT NOT NULL,
  note TEXT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id),
  INDEX idx_bazar_group (group_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS meal_polls (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  date BIGINT NOT NULL,
  type ENUM('slots', 'count', 'menu') NOT NULL,
  title VARCHAR(500) NULL,
  options_json TEXT NULL,
  close_at BIGINT NOT NULL,
  created_by_member_id CHAR(36) NOT NULL,
  non_voter_policy VARCHAR(16) NULL, -- null = group.default_non_voter_policy
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by_member_id) REFERENCES members(id),
  INDEX idx_polls_group_date (group_id, date)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS meal_poll_votes (
  poll_id CHAR(36) NOT NULL,
  member_id CHAR(36) NOT NULL,
  value_json TEXT NOT NULL,
  voted_at BIGINT NOT NULL,
  PRIMARY KEY (poll_id, member_id),
  FOREIGN KEY (poll_id) REFERENCES meal_polls(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id)
) ENGINE=InnoDB;

-- ===================== Chat (built when Step 7 arrives; table defined now
-- since it's part of the same schema file, unused until then) ==============

CREATE TABLE IF NOT EXISTS chat_messages (
  id CHAR(36) PRIMARY KEY,
  group_id CHAR(36) NOT NULL,
  member_id CHAR(36) NOT NULL,
  text TEXT NOT NULL,
  client_nonce CHAR(36) NULL,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES `groups`(id) ON DELETE CASCADE,
  FOREIGN KEY (member_id) REFERENCES members(id),
  INDEX idx_chat_group_created (group_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS device_tokens (
  user_id CHAR(36) NOT NULL,
  fcm_token VARCHAR(255) NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, fcm_token),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
