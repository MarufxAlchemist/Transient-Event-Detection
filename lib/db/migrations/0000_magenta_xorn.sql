CREATE EXTENSION IF NOT EXISTS ltree;
--> statement-breakpoint
CREATE SCHEMA "alerts";
--> statement-breakpoint
CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE SCHEMA "catalog";
--> statement-breakpoint
CREATE SCHEMA "core"; 
--> statement-breakpoint
CREATE SCHEMA "identity";
--> statement-breakpoint
CREATE SCHEMA "metrics";
--> statement-breakpoint
CREATE SCHEMA "tenant";
--> statement-breakpoint
CREATE TABLE "alerts"."alert_subscriptions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lab_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"event_types" text[] DEFAULT '{}' NOT NULL,
	"min_snr" double precision,
	"max_far" double precision,
	"min_gal_lat" real,
	"max_error_radius" real,
	"observatories" text[] DEFAULT '{}' NOT NULL,
	"channel" text NOT NULL,
	"channel_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"throttle_minutes" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts"."alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lab_id" uuid NOT NULL,
	"event_id" bigserial NOT NULL,
	"subscription_id" bigserial NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb NOT NULL,
	"response_code" integer,
	"error_message" text,
	"retry_count" smallint DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit"."audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lab_id" uuid,
	"user_id" uuid,
	"api_key_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_state" jsonb,
	"after_state" jsonb,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."observatories" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"event_types" text[] DEFAULT '{}' NOT NULL,
	"network" text,
	"country" text,
	"latitude" double precision,
	"longitude" double precision,
	"altitude_m" real,
	"website_url" text,
	"gcn_topic" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observatories_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "catalog"."observatory_capabilities" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"observatory_id" bigserial NOT NULL,
	"instrument" text NOT NULL,
	"band" text,
	"frequency_min_hz" double precision,
	"frequency_max_hz" double precision,
	"fov_deg2" real,
	"sensitivity" double precision,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog"."sky_regions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"ra_center" double precision NOT NULL,
	"dec_center" double precision NOT NULL,
	"radius_deg" real,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."event_annotations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lab_id" uuid NOT NULL,
	"event_id" bigserial NOT NULL,
	"user_id" uuid NOT NULL,
	"parent_id" bigserial,
	"content" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core"."event_classifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigserial NOT NULL,
	"lab_id" uuid NOT NULL,
	"classifier" text DEFAULT 'gstlal' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"prob_bns" real,
	"prob_nsbh" real,
	"prob_bbh" real,
	"prob_mass_gap" real,
	"prob_terrestrial" real,
	"has_ns" boolean,
	"has_remnant" boolean,
	"is_latest" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."event_detections" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigserial NOT NULL,
	"lab_id" uuid NOT NULL,
	"observatory_id" bigserial NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"ra" double precision NOT NULL,
	"dec" double precision NOT NULL,
	"error_radius" double precision NOT NULL,
	"snr" double precision NOT NULL,
	"far" double precision NOT NULL,
	"pipeline_version" text,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."event_embeddings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigserial NOT NULL,
	"lab_id" uuid NOT NULL,
	"model_name" text NOT NULL,
	"model_version" text NOT NULL,
	"embedding" text NOT NULL,
	"input_features" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_embeddings_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "core"."event_followup_requests" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lab_id" uuid NOT NULL,
	"event_id" bigserial NOT NULL,
	"observatory_id" bigserial NOT NULL,
	"requested_by" uuid NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"exposure_time_s" real,
	"filter_band" text,
	"notes" text,
	"response_notes" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "core"."event_localizations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigserial NOT NULL,
	"lab_id" uuid NOT NULL,
	"method" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"fits_url" text NOT NULL,
	"nside" integer,
	"area_50_deg2" real,
	"area_90_deg2" real,
	"vol_50_mpc3" double precision,
	"vol_90_mpc3" double precision,
	"has_ns_prob" real,
	"lineage" "ltree",
	"is_latest" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "core"."events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lab_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"detection_time" timestamp with time zone NOT NULL,
	"ra" double precision NOT NULL,
	"dec" double precision NOT NULL,
	"sky_position" text,
	"error_radius" double precision NOT NULL,
	"snr" double precision NOT NULL,
	"far" double precision NOT NULL,
	"fluence" double precision,
	"fluence_band" text,
	"t90" double precision,
	"dm" double precision,
	"peak_flux" double precision,
	"chirp_mass" double precision,
	"luminosity_distance" double precision,
	"gal_lat" double precision NOT NULL,
	"gal_lon" double precision NOT NULL,
	"sun_distance" double precision NOT NULL,
	"moon_distance" double precision NOT NULL,
	"redshift" double precision,
	"latency_us" bigserial NOT NULL,
	"source_catalog_id" text,
	"gcn_url" text,
	"status" text DEFAULT 'preliminary' NOT NULL,
	"ingested_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity"."api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "identity"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "identity"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"orcid_id" text,
	"is_verified" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "metrics"."event_metrics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lab_id" uuid NOT NULL,
	"event_id" bigserial NOT NULL,
	"stage" text NOT NULL,
	"duration_us" bigserial NOT NULL,
	"success" boolean DEFAULT true NOT NULL,
	"error_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant"."lab_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lab_id" uuid NOT NULL,
	"invited_by" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'researcher' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant"."lab_members" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lab_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'researcher' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant"."labs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"max_users" integer DEFAULT 5 NOT NULL,
	"max_events_per_day" integer DEFAULT 1000 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "labs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "alerts"."alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts"."alert_subscriptions" ADD CONSTRAINT "alert_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts"."alerts" ADD CONSTRAINT "alerts_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts"."alerts" ADD CONSTRAINT "alerts_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts"."alerts" ADD CONSTRAINT "alerts_subscription_id_alert_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "alerts"."alert_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit"."audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."observatory_capabilities" ADD CONSTRAINT "observatory_capabilities_observatory_id_observatories_id_fk" FOREIGN KEY ("observatory_id") REFERENCES "catalog"."observatories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_annotations" ADD CONSTRAINT "event_annotations_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_annotations" ADD CONSTRAINT "event_annotations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_annotations" ADD CONSTRAINT "event_annotations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_annotations" ADD CONSTRAINT "event_annotations_parent_id_event_annotations_id_fk" FOREIGN KEY ("parent_id") REFERENCES "core"."event_annotations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_classifications" ADD CONSTRAINT "event_classifications_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_classifications" ADD CONSTRAINT "event_classifications_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_detections" ADD CONSTRAINT "event_detections_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_detections" ADD CONSTRAINT "event_detections_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_detections" ADD CONSTRAINT "event_detections_observatory_id_observatories_id_fk" FOREIGN KEY ("observatory_id") REFERENCES "catalog"."observatories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_embeddings" ADD CONSTRAINT "event_embeddings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_embeddings" ADD CONSTRAINT "event_embeddings_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_followup_requests" ADD CONSTRAINT "event_followup_requests_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_followup_requests" ADD CONSTRAINT "event_followup_requests_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_followup_requests" ADD CONSTRAINT "event_followup_requests_observatory_id_observatories_id_fk" FOREIGN KEY ("observatory_id") REFERENCES "catalog"."observatories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_followup_requests" ADD CONSTRAINT "event_followup_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_localizations" ADD CONSTRAINT "event_localizations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."event_localizations" ADD CONSTRAINT "event_localizations_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."events" ADD CONSTRAINT "events_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "core"."events" ADD CONSTRAINT "events_ingested_by_users_id_fk" FOREIGN KEY ("ingested_by") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "identity"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "identity"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics"."event_metrics" ADD CONSTRAINT "event_metrics_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics"."event_metrics" ADD CONSTRAINT "event_metrics_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "core"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."lab_invitations" ADD CONSTRAINT "lab_invitations_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant"."lab_members" ADD CONSTRAINT "lab_members_lab_id_labs_id_fk" FOREIGN KEY ("lab_id") REFERENCES "tenant"."labs"("id") ON DELETE cascade ON UPDATE no action;