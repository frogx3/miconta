CREATE TABLE `agenda_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`description` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`due_date` text NOT NULL,
	`recurrence` text DEFAULT 'none' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`done_at` integer,
	`done_by_user_id` text,
	`done_via` text,
	`card_id` text,
	`previous_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`done_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agenda_items_card_due_uq` ON `agenda_items` (`card_id`,`due_date`);--> statement-breakpoint
CREATE INDEX `agenda_items_ws_due_idx` ON `agenda_items` (`workspace_id`,`due_date`);--> statement-breakpoint
CREATE TABLE `agenda_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`item_key` text NOT NULL,
	`user_id` text NOT NULL,
	`offset` text NOT NULL,
	`sent_at` integer,
	`kapso_message_id` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agenda_notifications_uq` ON `agenda_notifications` (`item_key`,`user_id`,`offset`);--> statement-breakpoint
CREATE TABLE `cash_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`card_id` text,
	`label` text,
	`currency` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_balances_card_uq` ON `cash_balances` (`card_id`);--> statement-breakpoint
CREATE INDEX `cash_balances_ws_idx` ON `cash_balances` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `whatsapp_link_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `user` ADD `whatsapp_phone` text;--> statement-breakpoint
ALTER TABLE `user` ADD `whatsapp_verified_at` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `whatsapp_opt_in` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `user_whatsapp_phone_uq` ON `user` (`whatsapp_phone`);