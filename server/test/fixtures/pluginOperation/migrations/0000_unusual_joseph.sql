CREATE TABLE "plugin_operation_probe"."records" (
	"space_id" text NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "records_space_id_user_id_key_pk" PRIMARY KEY("space_id","user_id","key")
);
