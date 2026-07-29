# TODO

## Before Product Hunt Launch

- [x] Usage, tiers, limits, etc.

## Billing

Core billing (near-term)

- [ ] Renewal cron job — at period end, call change_plan to re-grant balance
      products, rotate current_period_start/end
- [ ] WhatsApp template billing — record template send costs in the ledger
      (costs table is ready, just needs the ledger insert in the dispatcher)
- [ ] Plan downgrade scheduling — store pending plan change, apply at period end
      instead of immediately

Monetization (medium-term)

- [ ] Invoice generation — aggregate usage + overages from plans_products,
      create invoice + items
- [ ] Payment integration — Stripe checkout for paid plans, webhooks for payment
      success/failure/refunds

## General

- [ ] Improve routing of organization accounts and members

- [ ] Data export / DB dump

- [ ] Langfuse integration

- [ ] Encrypt API keys

- [ ] Improved error handling
      https://modelcontextprotocol.io/specification/2025-03-26/server/tools#error-handling

- [x] Timestamp precision (JS milliseconds vs PostgreSQL microseconds)

- [x] API keys equal agents (same roles and policies)

- [x] Split supabase.ts into different files

- [x] Revisit contacts and contacts_addresses

- [ ] Respond to all / non-contacts

- [ ] Enhanced privacy (optional, do not store messages from contacts)

- [ ] Coexistence welcome message pauses the conversation

- [x] Revisit whatsapp-management security

- [x] Sanitize tool names Error: 400 Invalid 'tools[0].function.name': string
      does not match pattern. Expected a string that matches the pattern
      '^[a-zA-Z0-9_-]+$'.

## Message revoke on whatsapp-web (whatsmeow bridge)

Deleting a message for the customer is impossible on the Cloud API — Meta
exposes no recall endpoint, and `EditMessage`/`RevokeMessage` in
`_shared/types/whatsapp_webhook_message_types.ts` are inbound Coexistence events
only. The `whatsapp-web` service is the one channel where it is actually
reachable, because whatsmeow speaks the protocol directly and already implements
`RevokeMessage`.

What it would take, none of which lives in this repo's edge functions:

- [ ] **Bridge endpoint** (`open-bsp-whatsmeow`) —
      `POST /sessions/:address/messages/:external_id/revoke`, server-to-server
      with the shared bridge token, calling whatsmeow's `BuildRevoke` +
      `SendMessage`. Needs the chat JID and the original message id, both of
      which the `messages` row already carries (`contact_address` /
      `group_address` and `external_id`).
- [ ] **Proxy route** in `whatsapp-web-management` — the UI never talks to the
      bridge directly, so this follows the existing `/sessions/*` pattern:
      validate the user JWT, check the org owns the message, forward.
- [ ] **Status merge** — on success, merge `{"deleted": now()}` onto the row,
      the same shape the Coexistence webhook already writes. The UI renders that
      tombstone today, so nothing is needed on that side.
- [ ] **Channel-aware UI** — the action can only be offered when
      `message.service === 'whatsapp-web'`; on `whatsapp` it must stay hidden
      rather than fail, since there is nothing to fall back to. The CRM-only
      hide (`public.set_message_hidden`) is what the other channels get.

Note whatsmeow also supports editing a sent message, which has the same shape of
problem and the same answer: bridge-only, never on the Cloud API.
