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
One complete, independently deployed copy of the shop system, with its own database and secrets, serving a group of tenants. Each cell has a role: the **canary** (the platform's own synthetic shop), **pooled** (many starter shops), or **dedicated** (one plus shop alone). A failure inside one cell reaches only that cell's tenants.
_Avoid_: Pod, cluster, shard, environment

**Cell directory**:
The control plane's list of cells: each one's role, capacity in shops, and where it answers. A cell enters it by registering itself once it is healthy; only a registered cell takes new shops.
_Avoid_: Cell registry, inventory, fleet (for the list itself)

**Plan**:
What a tenant pays for, which decides the kind of cell it runs in (**starter** shares a pooled cell; **plus** gets a dedicated cell of its own) and how much of that cell it may use: its rate quota, its Checkouts at once, and its product quota.
_Avoid_: Tier, package, subscription

**Rate quota**:
How many requests a second a tenant's buyers may send through the edge, with a short burst above it, set by its plan; past it, a request is told to slow down and never reaches the cell.
_Avoid_: Throttle, rate limit (alone), cap

**Product quota**:
The most products a tenant's catalog may hold, set by its plan and shown to its Merchant beside what it uses.
_Avoid_: Product limit, catalog size

**Noisy neighbour**:
A tenant whose traffic, or burst of Orders, would take a pooled cell's shared resources from the other tenants in it; the quotas and fair dispatch hold it to its share.
_Avoid_: Bad tenant, abuser, hot shop

**Synthetic Checkout**:
A Checkout the platform makes in a cell's synthetic shop to see that the cell's buyers can check out, on a fixed interval and whenever a release soaks there.
_Avoid_: Health check, probe, test order

**Placement**:
The choice of a new tenant's cell by its plan, made once when the tenant is created; when no cell of the plan's kind has room, the signup is refused rather than queued.
_Avoid_: Scheduling, assignment, allocation

**Edge router**:
The one entry point for every shop: it finds the tenant a request's address names and that tenant's cell, and passes the request to that cell with a tenant context only that cell accepts.
_Avoid_: Ingress, gateway, load balancer, (cell) router

**Release**:
One set of image versions of the shop system, built from one merge, that moves through the cells together.
_Avoid_: Deploy, version (alone), build

**Wave**:
A group of cells that receives a release together, in a fixed order: the canary first, then the pooled cells, then the dedicated cells. The control plane and the edge go with the first wave.
_Avoid_: Stage, ring, tier, environment

**Soak**:
The time a release runs in a wave, under watch, before it may go on to the next.
_Avoid_: Bake, burn-in, wait

**Gate**:
The checks a soaking release must keep passing in every cell of its wave (healthy, few server errors, no stuck Orders, no alerts, a synthetic shop's Checkout completing) before it is promoted; a release that fails them is halted where it is.
_Avoid_: Approval, quality gate, check (alone)

**Promotion**:
Moving a release that passed its gate on to the next wave; a halted release is never promoted, only replaced by the next release.
_Avoid_: Deploy, rollout, push

**Synthetic shop**:
The one internal shop in each cell that the platform buys from to check a release there; it counts toward no cell's capacity and has no Merchant.
_Avoid_: Test shop, canary shop, dummy tenant

**Fleet view**:
The platform operator's picture of every cell at once: its role and wave, how full it is, whether it is ready, which release it runs, and the latest promotions.
_Avoid_: Dashboard, status page, inventory

**Platform operator**:
The person who runs the platform itself (cells, releases, incidents); never a Merchant of any tenant.
_Avoid_: Admin, operator (alone), SRE

**Control plane**:
The part of the platform that knows every tenant and decides where and in what state each one is; it runs apart from every cell and never serves a buyer.
_Avoid_: Admin backend, management API, master

**Registry**:
The control plane's record of every tenant: its handle, name, status, cell, and Merchant credential.
_Avoid_: Tenant table, shop database, tenant directory

**Signup**:
A prospective Merchant's request for a new tenant; one signup makes at most one tenant, however often it is retried.
_Avoid_: Registration, onboarding, account creation

**Provisioning**:
The steps that turn a new tenant into a working shop: placing it in a cell if signup did not, activating it, and checking it as a buyer would.
_Avoid_: Setup, onboarding, deployment

**Active shop**:
A tenant that the edge router serves to buyers and its Merchant can sign in to.
_Avoid_: Live shop, enabled tenant

**Suspended shop**:
A tenant the platform operator has paused: nobody reaches it, its data is untouched, and its Pending orders still settle; it can be reinstated.
_Avoid_: Disabled, blocked (and frozen, which is a write freeze)

**Deleted shop**:
A tenant whose data has been removed from its cell and verified gone; only its record in the registry remains, and its handle is never reused.
_Avoid_: Removed, closed, archived

**Write freeze**:
A short time in which a shop can be browsed but not changed: buyers cannot add to a Cart or check out, and the Merchant cannot edit the catalog, while its data is being moved or restored. Its Pending orders still settle.
_Avoid_: Maintenance mode, downtime, suspension

**Tenant move**:
Moving one tenant, with all its data, from one cell to another under a write freeze; it ends served from the new cell with nothing of it left in the old one, or, if anything fails first, back where it was. A starter shop moved into a dedicated cell becomes plus.
_Avoid_: Migration (that is a schema change), rebalancing, transfer

**Tenant export**:
A copy of one tenant's data at one moment, taken by the platform on a schedule or on the operator's request, with a fingerprint of each kind of data so a copy can be checked.
_Avoid_: Backup (that is a whole database), dump, snapshot

**Restore point**:
A tenant export a shop can be restored to. Restoring puts the shop back exactly as it was at that export, and everything it changed since is lost; other shops are never touched.
_Avoid_: Backup, checkpoint, rollback

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
