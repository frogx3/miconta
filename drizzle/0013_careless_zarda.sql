CREATE TABLE `backup_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`finished_at` integer,
	`seen_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`requested_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `backup_exports_ws_idx` ON `backup_exports` (`workspace_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `user` ADD `in_app_notifications` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `deleted_at` integer;