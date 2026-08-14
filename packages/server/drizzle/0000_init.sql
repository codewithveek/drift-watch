CREATE TABLE "action_log" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"at" bigint NOT NULL,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text NOT NULL,
	"actor" text,
	"channel" text
);
--> statement-breakpoint
CREATE TABLE "agent_overrides" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"guardrails" jsonb,
	"tool_names" jsonb,
	"tool_policies" jsonb,
	"drift_detection_enabled" boolean,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint,
	"duration_ms" integer,
	"status" text NOT NULL,
	"stop_reason" text,
	"error_message" text,
	"model" text,
	"steps" integer,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"cost_usd" double precision,
	"tool_calls" jsonb,
	"trace_id" text
);
--> statement-breakpoint
CREATE TABLE "agent_state" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"status" text NOT NULL,
	"active_model" text,
	"active_version" integer NOT NULL,
	"updated_at" bigint NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "agent_tools" (
	"agent_id" text NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"fields" jsonb NOT NULL,
	"sensitive_fields" jsonb,
	"read_only" boolean DEFAULT false NOT NULL,
	"destructive" boolean DEFAULT false NOT NULL,
	"idempotent" boolean DEFAULT false NOT NULL,
	"synced_at" bigint NOT NULL,
	CONSTRAINT "agent_tools_agent_id_name_pk" PRIMARY KEY("agent_id","name")
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"owner" text,
	"service_name" text,
	"created_at" bigint NOT NULL,
	"guardrails" jsonb,
	"guardrails_source" text,
	"tool_names" jsonb,
	"drift_detection_enabled" boolean,
	"tool_policies" jsonb,
	"tool_policies_source" text,
	"last_synced_at" bigint,
	"sdk_version" text
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"agent_ids" jsonb,
	"created_at" bigint NOT NULL,
	"created_by" text NOT NULL,
	"last_used_at" bigint,
	"expires_at" bigint,
	"revoked_at" bigint,
	"revoked_by" text
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"action" text NOT NULL,
	"severity" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"recommended_action" text NOT NULL,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"resolved_at" bigint,
	"resolved_by" text,
	"channel" text
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"at" bigint NOT NULL,
	"actor" text NOT NULL,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"agent_id" text,
	"summary" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cooldowns" (
	"agent_id" text NOT NULL,
	"key" text NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "cooldowns_agent_id_key_pk" PRIMARY KEY("agent_id","key")
);
--> statement-breakpoint
CREATE TABLE "drift_history" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"at" bigint NOT NULL,
	"drift" boolean NOT NULL,
	"severity" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"recommended_action" text NOT NULL,
	"baseline_token_spend" double precision NOT NULL,
	"current_token_spend" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leader_locks" (
	"key" text PRIMARY KEY NOT NULL,
	"expires_at" bigint NOT NULL,
	"holder" text
);
--> statement-breakpoint
CREATE TABLE "model_switches" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"at" bigint NOT NULL,
	"from_model" text,
	"to_model" text
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_call_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigserial NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"tool" text NOT NULL,
	"field_path" text,
	"matched_reason" text,
	"input_summary" jsonb,
	"status" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"resolved_at" bigint,
	"resolved_by" text,
	"channel" text
);
--> statement-breakpoint
CREATE TABLE "tool_call_events" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"run_id" text,
	"tool" text NOT NULL,
	"at" bigint NOT NULL,
	"duration_ms" double precision NOT NULL,
	"ok" boolean NOT NULL,
	"gated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	"organization_id" text DEFAULT 'default',
	"must_change_password" boolean DEFAULT false,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_log" ADD CONSTRAINT "action_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_overrides" ADD CONSTRAINT "agent_overrides_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_overrides" ADD CONSTRAINT "agent_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_state" ADD CONSTRAINT "agent_state_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tools" ADD CONSTRAINT "agent_tools_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drift_history" ADD CONSTRAINT "drift_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_switches" ADD CONSTRAINT "model_switches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_approvals" ADD CONSTRAINT "tool_call_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "action_log_agent_at_idx" ON "action_log" USING btree ("agent_id","at");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_started_idx" ON "agent_runs" USING btree ("agent_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_started_idx" ON "agent_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "agents_org_idx" ON "agents" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_idx" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "approvals_agent_status_idx" ON "approvals" USING btree ("agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_agent_at_idx" ON "audit_events" USING btree ("agent_id","at");--> statement-breakpoint
CREATE INDEX "drift_history_agent_at_idx" ON "drift_history" USING btree ("agent_id","at");--> statement-breakpoint
CREATE INDEX "model_switches_agent_at_idx" ON "model_switches" USING btree ("agent_id","at");--> statement-breakpoint
CREATE INDEX "tool_call_approvals_agent_status_idx" ON "tool_call_approvals" USING btree ("agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "tool_call_events_agent_at_idx" ON "tool_call_events" USING btree ("agent_id","at");--> statement-breakpoint
CREATE INDEX "tool_call_events_agent_tool_at_idx" ON "tool_call_events" USING btree ("agent_id","tool","at");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");