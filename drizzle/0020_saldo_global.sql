CREATE TABLE `balance_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`currency` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`kind` text NOT NULL,
	`date` text NOT NULL,
	`description` text,
	`agenda_item_id` text,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agenda_item_id`) REFERENCES `agenda_items`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `balance_movements_item_uq` ON `balance_movements` (`agenda_item_id`);--> statement-breakpoint
CREATE INDEX `balance_movements_ws_date_idx` ON `balance_movements` (`workspace_id`,`date`);--> statement-breakpoint
-- Punto de partida: la suma de los saldos capturados de cada espacio y moneda, con la fecha de la última captura
-- (hora de Ciudad de México, UTC−6 sin horario de verano).
INSERT INTO `balance_movements` (`id`, `workspace_id`, `currency`, `amount_minor`, `kind`, `date`, `description`, `created_at`)
SELECT lower(hex(randomblob(16))), `workspace_id`, `currency`, sum(`amount_minor`), 'opening',
       date(max(`updated_at`) / 1000 - 21600, 'unixepoch'), 'Saldo inicial', max(`updated_at`)
FROM `cash_balances` WHERE `archived_at` IS NULL GROUP BY `workspace_id`, `currency`;
--> statement-breakpoint
-- Lo pagado o cobrado después de esa captura mueve el saldo, igual que a partir de ahora.
INSERT INTO `balance_movements` (`id`, `workspace_id`, `currency`, `amount_minor`, `kind`, `date`, `description`, `agenda_item_id`, `created_by_user_id`, `created_at`)
SELECT lower(hex(randomblob(16))), a.`workspace_id`, a.`currency`,
       CASE a.`kind` WHEN 'receivable' THEN a.`amount_minor` ELSE -a.`amount_minor` END, 'agenda',
       date(a.`done_at` / 1000 - 21600, 'unixepoch'), a.`description`, a.`id`, a.`done_by_user_id`, a.`done_at`
FROM `agenda_items` a JOIN `balance_movements` o ON o.`kind` = 'opening' AND o.`workspace_id` = a.`workspace_id` AND o.`currency` = a.`currency`
WHERE a.`status` = 'done' AND a.`done_at` > o.`created_at`;
