CREATE TABLE `email_inboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`account_id` text NOT NULL,
	`token` text NOT NULL,
	`trusted_domains` text DEFAULT '[]' NOT NULL,
	`created_by` text NOT NULL,
	`disabled_at` integer,
	`last_received_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_inboxes_account_uq` ON `email_inboxes` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_inboxes_token_uq` ON `email_inboxes` (`token`);--> statement-breakpoint
CREATE TABLE `email_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`message_key` text NOT NULL,
	`from_address` text NOT NULL,
	`subject` text NOT NULL,
	`dkim_domains` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`data` text,
	`movement_id` text,
	`raw_key` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`inbox_id`) REFERENCES `email_inboxes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`movement_id`) REFERENCES `movements`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_inbox_key_uq` ON `email_messages` (`inbox_id`,`message_key`);--> statement-breakpoint
CREATE INDEX `email_messages_inbox_idx` ON `email_messages` (`inbox_id`,`created_at`);