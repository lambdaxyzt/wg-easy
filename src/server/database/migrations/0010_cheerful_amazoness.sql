ALTER TABLE `clients_table` ADD `quota_limit` integer;--> statement-breakpoint
ALTER TABLE `clients_table` ADD `quota_period` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `clients_table` ADD `quota_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `clients_table` ADD `quota_anchor` text;--> statement-breakpoint
ALTER TABLE `clients_table` ADD `quota_period_start` text;--> statement-breakpoint
ALTER TABLE `clients_table` ADD `quota_exceeded` integer DEFAULT false NOT NULL;