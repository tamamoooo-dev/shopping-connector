-- Mini marts: a name shows only its words printed in the picture, and a size
-- only when printed (owner, 2026-11-05: "if the system is not sure it must not
-- guess"). shown_name: the printed words; '' = none (the reader's guess, kept
-- in name for telling repeats apart, never shown); NULL = read before this.
-- size_printed: 1 printed, 0 a guess (not shown), NULL unchecked.
ALTER TABLE minimart_offers ADD COLUMN shown_name TEXT;
ALTER TABLE minimart_offers ADD COLUMN size_printed INTEGER;
