CREATE TABLE `auth_rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_auth_rate_window` ON `auth_rate_limits` (`window_start`);