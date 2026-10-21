-- Permit one student to register for several different courses without a batch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollment_student_batch_nonempty
ON records(json_extract(data,'$.studentId'),json_extract(data,'$.batchId'))
WHERE kind='enrollments' AND coalesce(json_extract(data,'$.batchId'),'')!='';
--> statement-breakpoint
DROP INDEX IF EXISTS idx_enrollment_student_batch;
--> statement-breakpoint
-- Prevent concurrent first attendance in separate batches for the same teaching subject.
-- Applies only to newly auto-admitted enrollment records; existing enrollment rows are unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_enrollment_student_subject
ON records(json_extract(data,'$.studentId'), json_extract(data,'$.targetKey'))
WHERE kind='enrollments' AND json_extract(data,'$.targetKey') IS NOT NULL AND json_extract(data,'$.targetKey') != '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_batch_waitlist_lookup
ON records(kind,json_extract(data,'$.batchId'),created_at)
WHERE kind='batch-waitlist';
