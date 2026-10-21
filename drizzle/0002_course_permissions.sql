-- Reuse the existing polymorphic records table. These indexes guard the two
-- new relationship kinds against duplicate concurrent requests.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subcourse_parent_name
ON records(json_extract(data,'$.courseId'), lower(trim(json_extract(data,'$.name'))))
WHERE kind='subcourses';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollment_student_batch
ON records(json_extract(data,'$.studentId'), json_extract(data,'$.batchId'))
WHERE kind='enrollments';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_course_relation_lookup
ON records(kind, json_extract(data,'$.courseId'))
WHERE kind IN ('batches','subcourses','enrollments');
