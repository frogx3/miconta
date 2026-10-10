CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`bank` text NOT NULL,
	`customer_id` text,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `accounts_workspace_idx` ON `accounts` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`kind` text DEFAULT 'credit' NOT NULL,
	`is_digital` integer DEFAULT false NOT NULL,
	`last4` text,
	`label` text,
	`currency` text NOT NULL,
	`credit_limit_minor` integer,
	`cutoff_day` integer,
	`payment_due_day` integer,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cards_account_last4_uq` ON `cards` (`account_id`,`last4`);--> statement-breakpoint
CREATE INDEX `cards_workspace_idx` ON `cards` (`workspace_id`);--> statement-breakpoint
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
-- Cada cuenta financiera anterior pasa a ser una cuenta; las archivadas sin historial no se migran.
INSERT INTO `accounts` (`id`, `workspace_id`, `name`, `bank`, `customer_id`, `archived_at`, `created_at`, `updated_at`)
SELECT fa.`id`, fa.`workspace_id`, fa.`name`, fa.`bank`, NULL, fa.`archived_at`, fa.`created_at`, fa.`updated_at`
FROM `financial_accounts` fa
WHERE fa.`archived_at` IS NULL
  OR EXISTS (SELECT 1 FROM `movements` m WHERE m.`financial_account_id` = fa.`id`)
  OR EXISTS (SELECT 1 FROM `plans` p WHERE p.`financial_account_id` = fa.`id`)
  OR EXISTS (SELECT 1 FROM `import_batches` b WHERE b.`financial_account_id` = fa.`id`);--> statement-breakpoint
-- Cada plástico pasa a ser una tarjeta (mismo id) que hereda moneda, límite y fechas de su cuenta anterior.
INSERT INTO `cards` (`id`, `workspace_id`, `account_id`, `kind`, `is_digital`, `last4`, `label`, `currency`, `credit_limit_minor`, `cutoff_day`, `payment_due_day`, `archived_at`, `created_at`, `updated_at`)
SELECT p.`id`, fa.`workspace_id`, fa.`id`,
  CASE fa.`kind` WHEN 'credit' THEN 'credit' ELSE 'debit' END,
  CASE WHEN lower(coalesce(p.`label`, '')) LIKE '%digital%' THEN 1 ELSE 0 END,
  p.`last4`, p.`label`, fa.`currency`, fa.`credit_limit_minor`, fa.`cutoff_day`, fa.`payment_due_day`, NULL, p.`created_at`, p.`created_at`
FROM `card_plastics` p
JOIN `financial_accounts` fa ON fa.`id` = p.`financial_account_id`
WHERE fa.`id` IN (SELECT `id` FROM `accounts`);--> statement-breakpoint
-- Cuentas anteriores sin plásticos: una tarjeta sin terminación (mismo id que la cuenta) para no perder planes ni movimientos.
INSERT INTO `cards` (`id`, `workspace_id`, `account_id`, `kind`, `is_digital`, `last4`, `label`, `currency`, `credit_limit_minor`, `cutoff_day`, `payment_due_day`, `archived_at`, `created_at`, `updated_at`)
SELECT fa.`id`, fa.`workspace_id`, fa.`id`, CASE fa.`kind` WHEN 'credit' THEN 'credit' ELSE 'debit' END, 0, NULL, NULL,
  fa.`currency`, fa.`credit_limit_minor`, fa.`cutoff_day`, fa.`payment_due_day`, NULL, fa.`created_at`, fa.`updated_at`
FROM `financial_accounts` fa
WHERE fa.`id` IN (SELECT `id` FROM `accounts`)
  AND NOT EXISTS (SELECT 1 FROM `card_plastics` p WHERE p.`financial_account_id` = fa.`id`);--> statement-breakpoint
-- SQLite no permite cambiar llaves foráneas con ALTER; D1 tampoco deja apagarlas. Se respaldan las filas, se vacían los hijos, se recrean las tablas y se reinsertan en orden padre → hijo.
CREATE TABLE `bk_plan_events` AS SELECT * FROM `plan_events`;--> statement-breakpoint
CREATE TABLE `bk_plan_tags` AS SELECT * FROM `plan_tags`;--> statement-breakpoint
CREATE TABLE `bk_movements` AS SELECT * FROM `movements`;--> statement-breakpoint
CREATE TABLE `bk_batches` AS SELECT * FROM `import_batches`;--> statement-breakpoint
CREATE TABLE `bk_profiles` AS SELECT * FROM `import_profiles`;--> statement-breakpoint
CREATE TABLE `bk_plans` AS SELECT * FROM `plans`;--> statement-breakpoint
DELETE FROM `plan_events`;--> statement-breakpoint
DELETE FROM `plan_tags`;--> statement-breakpoint
DELETE FROM `movements`;--> statement-breakpoint
DELETE FROM `import_batches`;--> statement-breakpoint
DROP TABLE `plans`;--> statement-breakpoint
DROP TABLE `movements`;--> statement-breakpoint
DROP TABLE `import_batches`;--> statement-breakpoint
DROP TABLE `import_profiles`;--> statement-breakpoint
CREATE TABLE `import_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`header_fingerprint` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX `import_profiles_account_idx` ON `import_profiles` (`account_id`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`profile_id` text,
	`file_name` text NOT NULL,
	`file_key` text,
	`cutoff_date` text,
	`summary` text,
	`status` text DEFAULT 'applied' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`reverted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`profile_id`) REFERENCES `import_profiles`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX `import_batches_account_idx` ON `import_batches` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`card_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`match_text` text NOT NULL,
	`currency` text NOT NULL,
	`total_amount_minor` integer NOT NULL,
	`installment_amount_minor` integer NOT NULL,
	`total_installments` integer NOT NULL,
	`paid_installments` integer DEFAULT 0 NOT NULL,
	`interest_rate_bp` integer DEFAULT 0 NOT NULL,
	`first_charge_date` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`settled_at` integer,
	`settlement_note` text,
	`overridden_fields` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE INDEX `plans_workspace_status_idx` ON `plans` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `plans_card_idx` ON `plans` (`card_id`);--> statement-breakpoint
CREATE TABLE `movements` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`card_id` text,
	`batch_id` text NOT NULL,
	`unique_key` text NOT NULL,
	`date` text NOT NULL,
	`description` text NOT NULL,
	`description_norm` text NOT NULL,
	`reference` text,
	`charge_minor` integer DEFAULT 0 NOT NULL,
	`credit_minor` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`category_id` text,
	`plan_id` text,
	`plan_installment_no` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE restrict
);--> statement-breakpoint
CREATE UNIQUE INDEX `movements_account_key_uq` ON `movements` (`account_id`,`unique_key`);--> statement-breakpoint
CREATE INDEX `movements_workspace_date_idx` ON `movements` (`workspace_id`,`date`);--> statement-breakpoint
CREATE INDEX `movements_plan_idx` ON `movements` (`plan_id`);--> statement-breakpoint
CREATE INDEX `movements_batch_idx` ON `movements` (`batch_id`);--> statement-breakpoint
INSERT INTO `import_profiles` (`id`, `workspace_id`, `account_id`, `name`, `config`, `header_fingerprint`, `created_at`, `updated_at`) SELECT `id`, `workspace_id`, `financial_account_id`, `name`, `config`, `header_fingerprint`, `created_at`, `updated_at` FROM `bk_profiles`;--> statement-breakpoint
INSERT INTO `import_batches` (`id`, `workspace_id`, `account_id`, `profile_id`, `file_name`, `file_key`, `cutoff_date`, `summary`, `status`, `created_by`, `created_at`, `reverted_at`) SELECT `id`, `workspace_id`, `financial_account_id`, `profile_id`, `file_name`, `file_key`, `cutoff_date`, `summary`, `status`, `created_by`, `created_at`, `reverted_at` FROM `bk_batches`;--> statement-breakpoint
INSERT INTO `plans` (`id`, `workspace_id`, `card_id`, `type`, `name`, `match_text`, `currency`, `total_amount_minor`, `installment_amount_minor`, `total_installments`, `paid_installments`, `interest_rate_bp`, `first_charge_date`, `status`, `settled_at`, `settlement_note`, `overridden_fields`, `created_at`, `updated_at`) SELECT pl.`id`, pl.`workspace_id`, COALESCE((SELECT p.`id` FROM `card_plastics` p WHERE p.`financial_account_id` = pl.`financial_account_id` ORDER BY (p.`kind` = 'primary') DESC, p.`created_at`, p.`rowid` LIMIT 1), pl.`financial_account_id`), pl.`type`, pl.`name`, pl.`match_text`, pl.`currency`, pl.`total_amount_minor`, pl.`installment_amount_minor`, pl.`total_installments`, pl.`paid_installments`, pl.`interest_rate_bp`, pl.`first_charge_date`, pl.`status`, pl.`settled_at`, pl.`settlement_note`, pl.`overridden_fields`, pl.`created_at`, pl.`updated_at` FROM `bk_plans` pl;--> statement-breakpoint
INSERT INTO `movements` (`id`, `workspace_id`, `account_id`, `card_id`, `batch_id`, `unique_key`, `date`, `description`, `description_norm`, `reference`, `charge_minor`, `credit_minor`, `currency`, `category_id`, `plan_id`, `plan_installment_no`, `created_at`) SELECT `id`, `workspace_id`, `financial_account_id`, `plastic_id`, `batch_id`, `unique_key`, `date`, `description`, `description_norm`, `reference`, `charge_minor`, `credit_minor`, `currency`, `category_id`, `plan_id`, `plan_installment_no`, `created_at` FROM `bk_movements`;--> statement-breakpoint
INSERT INTO `plan_events` SELECT * FROM `bk_plan_events`;--> statement-breakpoint
INSERT INTO `plan_tags` SELECT * FROM `bk_plan_tags`;--> statement-breakpoint
DROP TABLE `bk_plan_events`;--> statement-breakpoint
DROP TABLE `bk_plan_tags`;--> statement-breakpoint
DROP TABLE `bk_movements`;--> statement-breakpoint
DROP TABLE `bk_batches`;--> statement-breakpoint
DROP TABLE `bk_profiles`;--> statement-breakpoint
DROP TABLE `bk_plans`;--> statement-breakpoint
DROP TABLE `card_plastics`;--> statement-breakpoint
DROP TABLE `financial_accounts`;
