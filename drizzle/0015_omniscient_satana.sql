PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_category_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`category_id` text,
	`pattern` text NOT NULL,
	`name` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_category_rules`("id", "workspace_id", "category_id", "pattern", "name", "created_at") SELECT "id", "workspace_id", "category_id", "pattern", NULL, "created_at" FROM `category_rules`;--> statement-breakpoint
DROP TABLE `category_rules`;--> statement-breakpoint
ALTER TABLE `__new_category_rules` RENAME TO `category_rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `category_rules_workspace_pattern_uq` ON `category_rules` (`workspace_id`,`pattern`);--> statement-breakpoint
CREATE INDEX `category_rules_category_idx` ON `category_rules` (`category_id`);