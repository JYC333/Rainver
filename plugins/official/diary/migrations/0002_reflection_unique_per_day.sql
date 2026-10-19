-- One reflection per entry and day is a database fact, not a writer habit:
-- two workers generating the same reflection at once must land one row.
ALTER TABLE public.diary_reflections
    ADD CONSTRAINT diary_reflections_entry_date_unique UNIQUE (entry_id, reflection_date);
