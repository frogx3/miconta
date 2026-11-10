-- Bancos nuevos en el catálogo: reclasifica las cuentas que estaban en "Otro" (p. ej. Plata).
UPDATE `accounts` SET `bank_id` = CASE
	WHEN lower(`bank`) LIKE '%american express%' OR lower(`bank`) = 'amex' THEN 'amex'
	WHEN lower(`bank`) LIKE '%azteca%' THEN 'azteca'
	WHEN lower(`bank`) LIKE '%invex%' THEN 'invex'
	WHEN lower(`bank`) LIKE '%klar%' THEN 'klar'
	WHEN lower(`bank`) LIKE '%mercado%pago%' THEN 'mercadopago'
	WHEN lower(`bank`) LIKE '%plata%' THEN 'plata'
	ELSE 'other' END
WHERE `bank_id` = 'other';--> statement-breakpoint
UPDATE `accounts` SET `bank` = CASE `bank_id`
	WHEN 'amex' THEN 'American Express' WHEN 'azteca' THEN 'Banco Azteca' WHEN 'invex' THEN 'Invex'
	WHEN 'klar' THEN 'Klar' WHEN 'mercadopago' THEN 'Mercado Pago' WHEN 'plata' THEN 'Plata'
	ELSE `bank` END;
