-- rainver:maintenance
-- Extend the existing invitation lifecycle without losing tokens, reservations or intent FKs.
ALTER TABLE "space_invitations" RENAME TO "user_invitations";
--> statement-breakpoint
ALTER TABLE "user_invitations" ALTER COLUMN "space_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_invitations" ALTER COLUMN "role" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_invitations" RENAME CONSTRAINT "space_invitations_pkey" TO "user_invitations_pkey";
--> statement-breakpoint
ALTER TABLE "user_invitations" RENAME CONSTRAINT "fk_space_invitations_invited_by_user_id_users" TO "fk_user_invitations_invited_by_user_id_users";
--> statement-breakpoint
ALTER TABLE "user_invitations" RENAME CONSTRAINT "space_invitations_space_id_fkey" TO "user_invitations_space_id_fkey";
--> statement-breakpoint
ALTER TABLE "user_invitations" RENAME CONSTRAINT "space_invitations_token_hash_key" TO "user_invitations_token_hash_key";
--> statement-breakpoint
ALTER TABLE "user_invitations" RENAME CONSTRAINT "ck_space_invitations_role" TO "ck_user_invitations_role";
--> statement-breakpoint
ALTER TABLE "user_invitations" RENAME CONSTRAINT "ck_space_invitations_status" TO "ck_user_invitations_status";
--> statement-breakpoint
ALTER INDEX "ix_space_invitations_space_id" RENAME TO "ix_user_invitations_space_id";
--> statement-breakpoint
ALTER INDEX "ix_space_invitations_status" RENAME TO "ix_user_invitations_status";
--> statement-breakpoint
ALTER INDEX "ix_space_invitations_reservation" RENAME TO "ix_user_invitations_reservation";
--> statement-breakpoint
ALTER TABLE "user_invitations" ADD CONSTRAINT "ck_user_invitations_scope" CHECK ((space_id IS NULL AND role IS NULL) OR (space_id IS NOT NULL AND role IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "ck_users_registration_source";--> statement-breakpoint
ALTER TABLE "registration_intents" DROP CONSTRAINT "ck_registration_intents_authority";--> statement-breakpoint
ALTER TABLE "registration_intents" DROP CONSTRAINT "ck_registration_intents_invitation_authority";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "ck_users_registration_source" CHECK (registration_source IN ('bootstrap', 'space_invitation', 'instance_invitation', 'admin_recovery', 'system'));--> statement-breakpoint
ALTER TABLE "registration_intents" ADD CONSTRAINT "ck_registration_intents_authority" CHECK (authority IN ('bootstrap', 'space_invitation', 'instance_invitation'));--> statement-breakpoint
ALTER TABLE "registration_intents" ADD CONSTRAINT "ck_registration_intents_invitation_authority" CHECK ((authority IN ('space_invitation', 'instance_invitation') AND invitation_id IS NOT NULL) OR (authority = 'bootstrap' AND invitation_id IS NULL));
