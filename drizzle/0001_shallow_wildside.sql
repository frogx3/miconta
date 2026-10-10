CREATE TABLE `category_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`category_id` text NOT NULL,
	`pattern` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `category_rules_workspace_pattern_uq` ON `category_rules` (`workspace_id`,`pattern`);--> statement-breakpoint
CREATE INDEX `category_rules_category_idx` ON `category_rules` (`category_id`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `ant_threshold_minor` integer;