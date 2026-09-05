Add a `cancel` step to the Cloudflare Worker project at {{DIR}}.

The project already has steps such as `confirm`, `setStock`, and `stock`; read AGENTS.md there first.

Rules for the new step:

- The request `{ "step": "cancel", "id": "<order id>" }` cancels the order: its status becomes "cancelled", and the lines of the order go back to stock: for each line, the inventory row of the line's sku gains the line's qty. Every sku of an order line has an inventory row.
- Only an order whose status is "confirmed" can be cancelled. When the order is draft, already cancelled, or does not exist, reply with `{ "refused": "not_confirmed" }` and change nothing.
- The inventory table caps qty at 100. When a restock would go over the cap, reply with `{ "refused": "restock_failed" }` and change nothing: the order stays confirmed and no stock changes.
- On success, reply with the order: `{ "id", "customer_id", "status", "note" }`, the same shape the `confirm` step replies with.
- Add tests for the new step, in the existing test file or in a new file under test/.
- `npm test` and `npm run typecheck` must both pass when you are done.

Constraints:

- Work only inside {{DIR}}. You may read anything under it, including node_modules. Do not read files elsewhere on this machine, and do not use the web.
- Do not add dependencies.

When you are done, reply with two things: the list of files you changed, and one paragraph on how the rules are enforced.
