import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCoreAlertsClient, createCoreFinanceClient, createCorePlanClient, createCoreRulesClient, financeContext } from "./core-finance.js";

const receipt = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });

export default definePluginEntry({
  id: "finance-ledger",
  name: "AgentX Finance Ledger",
  description: "Read-only balances, transactions and monthly totals from the AgentX Core finance ledger.",
  register(api) {
    const ask = createCoreFinanceClient({ baseUrl: api.pluginConfig?.agentxUrl });
    const teach = createCoreRulesClient({ baseUrl: api.pluginConfig?.agentxUrl });
    const alertsClient = createCoreAlertsClient({ baseUrl: api.pluginConfig?.agentxUrl });
    const planClient = createCorePlanClient({ baseUrl: api.pluginConfig?.agentxUrl });
    const agentIds = Array.isArray(api.pluginConfig?.agentIds) && api.pluginConfig.agentIds.length
      ? api.pluginConfig.agentIds : ["comptable"];

    api.registerTool(context => {
      if (!financeContext(context, agentIds)) return null;
      return {
        name: "finance_ledger",
        label: "Finance Ledger",
        description: "Read the owner's reconciled finance ledger (AgentX Core). Every amount and total is computed by Core: "
          + "quote the *Display strings as given and never add, average or convert amounts yourself. "
          + "balances = latest closing balance per account with its date; "
          + "transactions = matching rows plus totals (filter by account code like EOP or CARD, from/to YYYY-MM-DD, "
          + "q = words of the merchant description); monthly = in/out/net per month plus the average; "
          + "yearly = in/out/net per calendar year (use with tag, category or q for multi-year questions); "
          + "insights = advice material over the last `months` (default 12): savings rate per month, stable "
          + "recurring charges with yearly cost, category trends (last 3 months vs before), large recent expenses; "
          + "categories = totals per category (null = not categorized yet); uncategorized = descriptions still "
          + "to classify, biggest first, with a suggestedPattern; rules = the category list and learned rules; "
          + "excludeCategory 'Virements internes' removes transfers between the owner's accounts; "
          + "statements = ingested statements and any that need review. If nothing matches, say so; never estimate.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["balances", "transactions", "monthly", "yearly", "insights", "categories", "uncategorized", "rules", "statements"] },
            account: { type: "string", maxLength: 80 },
            from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            q: { type: "string", maxLength: 80 },
            category: { type: "string", maxLength: 60 },
            tag: { type: "string", maxLength: 60 },
            excludeCategory: { type: "string", maxLength: 60 },
            months: { type: "integer", minimum: 3, maximum: 60 },
            limit: { type: "integer", minimum: 1, maximum: 200 },
            status: { type: "string", enum: ["reconciled", "needs_review"] },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(_callId, params) {
          return receipt(await ask(params));
        },
      };
    }, { name: "finance_ledger", optional: true });

    api.registerTool(context => {
      if (!financeContext(context, agentIds)) return null;
      return {
        name: "finance_categorize",
        label: "Finance Categorize",
        description: "Save what the owner explicitly confirmed in this conversation. `rules`: every transaction whose "
          + "description contains `pattern` gets `category` and `tags`, past and future. Use only after the owner answered; "
          + "never guess. Category must be one of the list from finance_ledger action rules. Tags are short words "
          + "(activity, first name, partageable). `transactions`: a decision for single rows by their ledger id (from "
          + "finance_ledger transactions), e.g. one Walmart purchase that was for a child; category null removes the "
          + "decision. Report how many transactions each rule now covers.",
        parameters: {
          type: "object",
          properties: {
            rules: {
              type: "array", minItems: 1, maxItems: 25,
              items: {
                type: "object",
                properties: {
                  pattern: { type: "string", minLength: 3, maxLength: 80 },
                  category: { type: "string", maxLength: 60 },
                  tags: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 8 },
                },
                required: ["pattern", "category"],
                additionalProperties: false,
              },
            },
            transactions: {
              type: "array", minItems: 1, maxItems: 50,
              items: {
                type: "object",
                properties: {
                  id: { type: "string", pattern: "^[a-f0-9]{24}$" },
                  category: { type: ["string", "null"], maxLength: 60 },
                  tags: { type: "array", items: { type: "string", maxLength: 40 }, maxItems: 8 },
                },
                required: ["id", "category"],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        async execute(_callId, params) {
          return receipt(await teach(params));
        },
      };
    }, { name: "finance_categorize", optional: true });

    api.registerTool(context => {
      if (!financeContext(context, agentIds)) return null;
      return {
        name: "finance_alerts",
        label: "Finance Alerts",
        description: "Deterministic finance alerts computed by Core (statement to review, stale data, balance under the "
          + "cushion, large expense, new recurring charge, category spike). Core decides when to alert; you phrase it. "
          + "report=false lists pending alerts; report=true returns them and marks them reported (use it only when you "
          + "deliver them to the owner, e.g. in the scheduled check). Quote the *Display amounts as given.",
        parameters: {
          type: "object",
          properties: { report: { type: "boolean" } },
          additionalProperties: false,
        },
        async execute(_callId, params) {
          return receipt(await alertsClient(params));
        },
      };
    }, { name: "finance_alerts", optional: true });

    api.registerTool(context => {
      if (!financeContext(context, agentIds)) return null;
      return {
        name: "finance_plan",
        label: "Finance Plan",
        description: "The owner's financial plan: budget lines, debts, credit lines, provisions, assets, tax room, open items, "
          + "cash allocation, upcoming deadlines (watch), settled items (milestones), phase and exceptional tags. "
          + "action get reads it. action apply changes it ONLY with what the owner explicitly said in this conversation "
          + "(e.g. 'le T2 est payé' → remove the open item, add a settled milestone; 'mon REER vaut 215 000 $' → update the asset). "
          + "ops: {op: add|update|remove|set, section, match (words of the item) or index, item (fields to set), value (for set)}. "
          + "Amounts are integer cents (monthlyCents, balanceCents, valueCents, annualCents...), rates in basis points (rateBp). "
          + "Confirm what changed in one line.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["get", "apply"] },
            ops: {
              type: "array", minItems: 1, maxItems: 20,
              items: {
                type: "object",
                properties: {
                  op: { type: "string", enum: ["add", "update", "remove", "set"] },
                  section: { type: "string", enum: ["phase", "excludeTags", "budget", "debts", "credit", "provisions", "assets",
                    "milestones", "openItems", "allocations", "watch", "taxRoom"] },
                  match: { type: "string", maxLength: 80 },
                  index: { type: "integer", minimum: 0 },
                  item: { type: "object" },
                  value: {},
                },
                required: ["op", "section"],
              },
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(_callId, params) {
          return receipt(await planClient(params));
        },
      };
    }, { name: "finance_plan", optional: true });
  },
});
