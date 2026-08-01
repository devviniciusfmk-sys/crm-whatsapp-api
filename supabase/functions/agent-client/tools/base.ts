import { z } from "zod";
import type { RequestContext } from "../protocols/base.ts";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ToolDefinition<
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType,
  Config = void,
> = {
  provider: "local";
  type: "function" | "custom" | "sql" | "http" | "mcp";
  name: string;
  description?: string;
  inputSchema: z.core.JSONSchema.BaseSchema; // TODO: "custom" does not need input schema
  outputSchema: z.core.JSONSchema.BaseSchema;
  /**
   * Every implementation is handed the same four arguments; one that needs
   * only the first declares `(input)` and TypeScript accepts it, the way it
   * accepts any function ignoring trailing parameters.
   *
   * This used to be a conditional type: tools carrying a `Config` got
   * `context` and `supabaseClient`, and `function` tools got the input alone.
   * That quietly decided a built-in tool could never *do* anything — only
   * compute and return — which is why `handoff.ts` sat unfinished with an
   * empty body. A tool whose entire purpose is a side effect had no way to
   * reach the conversation it was called from.
   *
   * `Config` stays because http/sql genuinely carry per-instance
   * configuration; tools without it receive `undefined`. - 2026/08/01
   */
  implementation: (
    input: z.infer<InputSchema>,
    config: Config,
    context: RequestContext,
    supabaseClient: SupabaseClient,
  ) => Promise<z.infer<OutputSchema>>;
};
