CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_uq` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_user_idx` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
DROP INDEX `agenda_notifications_uq`;--> statement-breakpoint
ALTER TABLE `agenda_notifications` ADD `channel` text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `agenda_notifications_uq` ON `agenda_notifications` (`item_key`,`user_id`,`offset`,`channel`);