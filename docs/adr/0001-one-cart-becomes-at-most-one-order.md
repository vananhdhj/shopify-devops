---
status: accepted
---

# One cart becomes at most one order

A checkout key only makes retries of the *same* checkout request safe; a buyer who presses Back and checks out the same cart again sends a new key and would get a second order. We store the source cart ID on each order under a uniqueness constraint in the `orders` schema, so a second checkout of an already-ordered cart returns `409` and the storefront starts a fresh cart after every checkout, accepted or rejected.

## Considered Options

- **Rely on the checkout key alone**: rejected; it leaves accidental duplicate purchases possible.
- **Catalog marks the cart `CHECKED_OUT`**: rejected; it adds a second cross-service write to every checkout, plus partial-failure handling when one write succeeds and the other does not.

## Consequences

- A rejected order (out of stock or payment declined) still consumes its cart; the buyer retries with a new cart.
- The checkout request hash covers only cart ID and payment scenario, not cart contents. The order's item snapshot taken at commit time is the record of what was bought, so a retry returns that snapshot even if the cart was edited afterwards.
- The cart remains editable in the catalog after checkout, but editing it has no effect on the order.
