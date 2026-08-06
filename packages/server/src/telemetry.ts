// telemetry.ts — preload; must run before anything else imports
import 'dotenv/config'; // load .env into process.env before anything reads it
import { bootstrapTelemetry, loadDriftWatchConfigFromEnv } from '@driftwatch/sdk';

bootstrapTelemetry(loadDriftWatchConfigFromEnv().telemetry);