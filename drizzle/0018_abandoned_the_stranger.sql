ALTER TABLE `accounts` ADD `bank_id` text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `tier` text DEFAULT 'professional' NOT NULL;--> statement-breakpoint
UPDATE `accounts` SET `bank_id` = CASE
	WHEN lower(`bank`) LIKE '%banorte%' THEN 'banorte'
	WHEN lower(`bank`) LIKE '%banamex%' THEN 'banamex'
	WHEN lower(`bank`) LIKE '%bbva%' THEN 'bbva'
	WHEN lower(`bank`) LIKE '%santander%' THEN 'santander'
	WHEN lower(`bank`) LIKE '%banj%rcito%' THEN 'banjercito'
	WHEN lower(`bank`) LIKE '%hsbc%' THEN 'hsbc'
	ELSE 'other' END;--> statement-breakpoint
UPDATE `accounts` SET `bank` = CASE `bank_id`
	WHEN 'banorte' THEN 'Banorte' WHEN 'banamex' THEN 'Banamex' WHEN 'bbva' THEN 'BBVA'
	WHEN 'santander' THEN 'Santander' WHEN 'banjercito' THEN 'Banjército' WHEN 'hsbc' THEN 'HSBC'
	ELSE `bank` END;
