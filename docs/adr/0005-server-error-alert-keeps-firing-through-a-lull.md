---
status: accepted
---

# The server-error alert keeps firing through a one-minute traffic lull

`ShopServerErrorRatioHigh` only evaluates when the request rate is above a minimum (0.1 req/s), so it does not page on a handful of requests. That guard also means a quiet moment can end the alert while checkout still fails: in bad-release drill run 1 the alert resolved with 100% of checkouts failing, 36 seconds before the revert reached the pods. We add `keep_firing_for: 1m` to the rule so a short lull no longer ends it. A false "resolved" tells whoever is on call that the problem is over; a resolve that arrives a minute late is a small annoyance by comparison.

## Considered Options

- **No `keep_firing_for` (the rule as first written)**: rejected; it resolves on lulls, as run 1 showed, and flaps in quiet periods such as nights or a low-traffic shop.
- **A longer value (5m or more)**: rejected; it delays every resolve further without fixing the case one minute cannot handle anyway.
- **A "no traffic" or storefront-unreachable alert from an external probe (for example a blackbox exporter)**: not added; it is outside the POC's scope and belongs to the next phase.

## Consequences

- Every resolve of this alert arrives about a minute later: in the drill, about 3 minutes after recovery instead of about 2. The rollback itself is no slower.
- It does not stop the alert from firing again just after a fix while old errors are still in its 2-minute window, and a lull longer than a minute still ends it.
- If the shop goes fully down and traffic drops to zero, the alert still ends after the minute. That is a missing availability alert, not an error-rate problem.
- Remove it only if alerts must resolve as fast as possible and traffic lulls never happen; neither holds for this lab.
- The drill still keeps traffic steady (one Checkout a second) for both reasons, and the README's known limits describe the trade-off. The drill's recorded timings (run 2) were measured before this rule change.
