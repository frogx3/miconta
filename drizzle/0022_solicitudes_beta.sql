ALTER TABLE `user` ADD `approval_status` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `requested_at` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `reviewed_at` integer;--> statement-breakpoint
ALTER TABLE `user` ADD `reviewed_by` text;--> statement-breakpoint
ALTER TABLE `user` ADD `review_note` text;--> statement-breakpoint
ALTER TABLE `user` ADD `signup_interest` text;--> statement-breakpoint
ALTER TABLE `user` ADD `beta_member` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `privacy_accepted_at` integer;--> statement-breakpoint
CREATE INDEX `user_approval_idx` ON `user` (`approval_status`);