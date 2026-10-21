/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as gate from "../gate.js";
import type * as lab from "../lab.js";
import type * as lib_core from "../lib/core.js";
import type * as lib_guard from "../lib/guard.js";
import type * as lib_jobs from "../lib/jobs.js";
import type * as lib_provider from "../lib/provider.js";
import type * as lib_retry from "../lib/retry.js";
import type * as report from "../report.js";
import type * as work from "../work.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  gate: typeof gate;
  lab: typeof lab;
  "lib/core": typeof lib_core;
  "lib/guard": typeof lib_guard;
  "lib/jobs": typeof lib_jobs;
  "lib/provider": typeof lib_provider;
  "lib/retry": typeof lib_retry;
  report: typeof report;
  work: typeof work;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
