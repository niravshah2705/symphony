# Google Analytics 4

Software Factory supports an optional Google Analytics 4 web data stream. A deployment
does not load the Google tag or queue events unless it receives a valid
`G-...` measurement ID at deploy time: the SPA reads it from `config.js`, and the
static marketing pages on `www` get a per-page gtag snippet injected at build time
by `scripts/build-marketing-site.js`. On a configured deployment, analytics is
enabled by default for each browser and can be disabled at any time through the
persistent **Cookie Preferences** control in the application footer.

## Create and configure the stream

1. In Google Analytics, [create a GA4 property and a **Web** data
   stream](https://support.google.com/analytics/answer/14183469) for the public
   SPA origin.
2. Copy the stream's [measurement
   ID](https://support.google.com/analytics/answer/12270356) (`G-...`).
3. Under the stream's **Enhanced measurement → Page views → advanced settings**,
   disable **Page changes based on browser history events**. Software Factory uses a
   fragment router and sends its own virtual `page_view` event for each route;
   enabling both mechanisms can double-count navigation. This follows Google's
   guidance for [manual SPA page
   views](https://developers.google.com/analytics/devguides/collection/ga4/views).
4. In **Admin → Data display → Custom definitions**, create one custom
   dimension with these values:
   - **Dimension name:** `Authentication status`
   - **Scope:** Event
   - **Event parameter:** `authentication_status`

Do not create a custom dimension for `user_id`. GA4 handles it through the
built-in **Signed in with user ID** dimension; registering raw IDs as a custom
dimension creates unnecessary high-cardinality data. Custom dimensions apply
only to data collected after they are created and can take 24–48 hours to
become available in reports. See Google's guidance for
[event-scoped custom dimensions](https://support.google.com/analytics/answer/14239696)
and [User-ID](https://developers.google.com/analytics/devguides/collection/ga4/user-id).

The client disables the tag's automatic initial page view. For GA's page URL and
title context, it supplies only the site origin plus a canonical top-level route
such as `/#/agent` or `/#/invite`, including at configuration scope for automatic
events. Browser pathnames, query strings, hash parameters, dynamic identifiers,
and UI-derived titles are discarded, so an invitation token, conversation ID,
organization ID, or project ID is never included in `page_location`. Google
signals and ad-personalization signals are disabled by the client configuration.

Every manual page view also includes `authentication_status`, with an
allowlisted value of `anonymous` or `authenticated`. For an authenticated
Firebase deployment, the client configures GA4 `user_id` from the
gateway-verified `session.user.sub`. That subject is the only accepted identity
source: display names, email addresses, organizations, projects, access tokens,
and URL values are never used. Values with common PII/URL shapes or more than
256 characters are rejected. The ID is configured at tag scope, never copied
into an event parameter, and is cleared with JavaScript `null` if an in-page
session expires. A visitor who has never signed in has no `user_id` setting.

## Configure a deployment

The measurement ID is public configuration, not a credential. Use the setting
for the deployment path you run:

- GitHub Actions / Firebase Hosting: repository variable
  `GOOGLE_ANALYTICS_MEASUREMENT_ID`.
- Cloud Build / GCS: substitution
  `_GOOGLE_ANALYTICS_MEASUREMENT_ID=G-XXXXXXXXXX`.
- `deploy/gcp/deploy.sh`: environment variable
  `GOOGLE_ANALYTICS_MEASUREMENT_ID=G-XXXXXXXXXX`.

`deploy/gcp/bootstrap.sh` synchronizes the optional environment value with the
GitHub repository variable; running it with the value empty removes a stale
variable. The committed `public/config.js` keeps the value empty, so local
development and automated tests never contact Google Analytics. Removing the
deployment variable and republishing the SPA and the marketing site disables
collection again.

## Marketing site (www.archagentix.com)

The same measurement ID flows to both hosts: `deploy.yml` writes it into the SPA
runtime `config.js`, and `deploy-www.yml` passes it as
`GOOGLE_ANALYTICS_MEASUREMENT_ID` to `scripts/build-marketing-site.js`, which
injects the gtag bootstrap before `</head>` of every generated page. An unset or
empty variable publishes the marketing tree with no tag at all, and a malformed
one fails the build. Because these are full documents rather than an SPA, the
snippet leaves GA4's automatic page view on — one `page_view` per marketing URL
(landing, blog, pricing, contact, legal), which is what stitches the pre-signup
part of the user journey to the platform's route views in the same stream.

The snippet mirrors the platform's privacy posture: consent mode defaults to
`analytics_storage: granted` unless `localStorage["ai-fleet.analytics-consent"]`
reads `disabled` at page load, and all ad signals stay denied. The Cookie
Preferences dialog itself lives in the SPA; the marketing origin shares neither
its localStorage nor (by default) its `_ga` cookie with `platform`, so the two
hosts join journeys through the shared stream and, for signed-in visitors, the
`user_id` the SPA sets. The `www` CSP in `firebase.json` allows
`www.googletagmanager.com` (script), `*.google-analytics.com` and
`analytics.google.com` (collect beacons), and `www.google-analytics.com` (image
fallback); `scripts/marketing-site.test.js` pins both the injection and these
origins.

## Visitor analytics preference

The footer's **Cookie Preferences** dialog uses an opt-out model: essential
functionality is always on, while Analytics starts enabled. The choice is saved
locally as one of these exact values:

```text
localStorage["ai-fleet.analytics-consent"] = "enabled" | "disabled"
```

Missing, unreadable, or invalid preference data preserves the default-enabled
behavior on a deployment that has a valid measurement ID. Choosing Disabled
persists the preference before taking effect, sends Google's consent update when
the tag is already present, expires JavaScript-accessible `_ga` and `_ga_*`
cookies, and reloads the same hash route. On the next startup the client does not
create `dataLayer` or `gtag` and does not request Google's script. Future virtual
page views remain suppressed. Choosing Enabled again reloads the same route and
resumes configured tracking. The in-page revocation follows Google's
[consent update guidance](https://developers.google.com/tag-platform/security/guides/consent).

This browser preference is separate from deployment configuration. Removing the
measurement ID disables GA4 for every visitor regardless of their saved choice.
The public Privacy Notice at `#/privacy` describes the control and the data sent.

## Verify

Republish the SPA, open the deployed site, and navigate between two sidebar
routes. Verify the tag with [Google Tag
Assistant](https://tagassistant.google.com/) or GA4 DebugView/Realtime:

- exactly one `page_view` appears for the initial route;
- one additional `page_view` appears per route transition; and
- `page_location` contains only the normalized route, with no hash query string
  or internal identifier.

For an anonymous visit, the page view should contain
`authentication_status=anonymous` and no `user_id`. For an authenticated visit,
it should contain `authentication_status=authenticated`, while `user_id` appears
only on the GA configuration command. In reports, compare the custom
**Authentication status** dimension or GA4's built-in **Signed in with user ID**
dimension. Historical events are not reprocessed after either feature is added.
For the marketing site, republish `www`, open `https://www.archagentix.com/`, and
confirm exactly one `page_view` for the landing URL carries the full
`https://www.archagentix.com/` location; setting the stored consent key to
`disabled` before load must flip `analytics_storage` to `denied`.

Software Factory intentionally does not show a first-visit banner because the selected
model is opt-out by default. The footer control and Privacy Notice do not replace
deployment-specific legal review. The operator remains responsible for any
additional consent, disclosure (including the stable authenticated identifier),
retention, and regional controls required for the deployment.
