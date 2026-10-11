# Shopify DevOps Lab

A small multi-tenant commerce platform that exists to be built, deployed, observed, broken, and recovered: many shops, each run by its own merchant, on shared infrastructure. The commerce domain is narrow on purpose: guest buyers, one merchant per shop, simulated payment.

## Language

### Platform

**Tenant**:
One shop on the platform: its products, Carts, Orders, and Merchant. Every piece of shop data belongs to exactly one tenant, and no tenant can see or change another's.
_Avoid_: Store, account, customer, organisation

**Handle**:
A tenant's short, unique, address-safe name; the shop is reached at `<handle>.` followed by the platform's domain.
_Avoid_: Slug, subdomain, shop ID

**Tenant context**:
The signed statement, attached at the platform's edge, of which tenant a request is for; the only way any part of the system learns the tenant.
_Avoid_: Tenant header, tenant ID parameter

**Cell**:
One complete, independently deployed copy of the shop system, serving a group of tenants.
_Avoid_: Pod, cluster, shard, environment

**Platform operator**:
The person who runs the platform itself (cells, releases, incidents); never a Merchant of any tenant.
_Avoid_: Admin, operator (alone), SRE

**Control plane**:
The part of the platform that knows every tenant and decides where and in what state each one is; it runs apart from every cell and never serves a buyer.
_Avoid_: Admin backend, management API, master

**Registry**:
The control plane's record of every tenant: its handle, name, status, cell, and Merchant credential.
_Avoid_: Tenant table, shop database, directory

**Signup**:
A prospective Merchant's request for a new tenant; one signup makes at most one tenant, however often it is retried.
_Avoid_: Registration, onboarding, account creation

**Provisioning**:
The steps that turn a new tenant into a working shop: placing it in a cell, activating it, and checking it as a buyer would.
_Avoid_: Setup, onboarding, deployment

**Active shop**:
A tenant that the routers serve to buyers and its Merchant can sign in to.
_Avoid_: Live shop, enabled tenant

**Suspended shop**:
A tenant the platform operator has paused: nobody reaches it, its data is untouched, and its Pending orders still settle; it can be reinstated.
_Avoid_: Disabled, blocked, frozen

**Deleted shop**:
A tenant whose data has been removed from its cell and verified gone; only its record in the registry remains, and its handle is never reused.
_Avoid_: Removed, closed, archived

### People

**Guest buyer**:
An anonymous shopper with no account, who reaches their Cart and Order only through tokens they hold.
_Avoid_: Customer, user, account

**Merchant**:
The person who runs one tenant's shop: manages its products and fulfills its Orders, and has no access to any other tenant.
_Avoid_: Admin user, seller, owner

### Catalog

**Product**:
Something the Merchant sells, with one server-owned price and a Stock count.
_Avoid_: Item, SKU, listing

**Stock**:
The number of units of a Product still available to sell; never negative, and changed only by Inventory effects once a Product exists.
_Avoid_: Inventory level, quantity on hand

**Cart**:
A guest buyer's server-side list of products and quantities, identified by a cart token; adding to a cart never deducts stock. A cart becomes at most one Order.
_Avoid_: Basket, bag, session

**Inventory effect**:
One stock change in the catalog (a deduction or a release) applied at most once per Order and action, however many times it is requested.
_Avoid_: Reservation, stock update, hold

### Orders

**Checkout**:
The act of turning a Cart into a pending Order at server-owned prices.
_Avoid_: Purchase, place order

**Checkout key**:
A client-generated key that makes retries of one Checkout request return the same Order; it does not stop a second Checkout of the same Cart (the one-order-per-cart rule does).
_Avoid_: Idempotency token, request ID

**Payment scenario**:
The simulated payment outcome a Guest buyer chooses at Checkout (`approve`, `decline`, or `slow`); no money or card data exists anywhere in the system.
_Avoid_: Payment method, card, test card

**Order**:
The record of one Checkout of one Cart, carrying an immutable snapshot of its items and prices.
_Avoid_: Purchase, transaction

**Order token**:
An unguessable token handed to the Guest buyer at Checkout; the only way to read that Order's status, and only at the tenant where it was placed.
_Avoid_: Order ID, order-read token, receipt link

**Pending order**:
An Order accepted but not yet decided; it stays pending, never expires, until stock and payment are settled.
_Avoid_: Unpaid order, draft order

**Confirmed order**:
An Order whose stock was deducted and whose Payment scenario approved; only a Confirmed order can become Fulfilled.
_Avoid_: Paid order, completed order

**Rejected order**:
A terminal Order that will never ship, either because stock was insufficient or the Payment scenario declined; it holds no stock.
_Avoid_: Failed order, cancelled order

**Fulfilled order**:
A Confirmed order the Merchant has marked as shipped; terminal.
_Avoid_: Shipped, delivered, completed
