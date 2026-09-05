Add a `cancel` step to the Cloudflare Worker project at {{DIR}}.

The project already has steps such as `confirm`; read AGENTS.md there first.

Rules for the new step:

- The request `{ "step": "cancel", "id": "<order id>" }` cancels the order: its status becomes "cancelled".
- Only an order whose status is "confirmed" can be cancelled.
- When the order is draft, already cancelled, or does not exist, reply with `{ "refused": "not_confirmed" }` and change nothing.
- On success, reply with the order: `{ "id", "customer_id", "status", "note" }`, the same shape the `confirm` step replies with.
- Add a test for the new step, in the existing test file or in a new file under test/.
- `npm test` and `npm run typecheck` must both pass when you are done.

Constraints:

- Work only inside {{DIR}}. You may read anything under it, including node_modules. Do not read files elsewhere on this machine, and do not use the web.
- Do not add dependencies.

When you are done, reply with two things: the list of files you changed, and one paragraph on how the "only a confirmed order" rule is enforced.
