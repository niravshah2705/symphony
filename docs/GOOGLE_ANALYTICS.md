# Google Analytics 4

AI Fleet supports an optional Google Analytics 4 web data stream. Analytics is
disabled by default: the Google tag is not downloaded and no events are queued
unless the SPA receives a valid `G-...` measurement ID at deploy time.

## Create and configure the stream

1. In Google Analytics, [create a GA4 property and a **Web** data
   stream](https://support.google.com/analytics/answer/14183469) for the public
   SPA origin.
2. Copy the stream's [measurement
   ID](https://support.google.com/analytics/answer/12270356) (`G-...`).
3. Under the stream's **Enhanced measurement → Page views → advanced settings**,
   disable **Page changes based on browser history events**. AI Fleet uses a
   fragment router and sends its own virtual `page_view` event for each route;
   enabling both mechanisms can double-count navigation. This follows Google's
   guidance for [manual SPA page
   views](https://developers.google.com/analytics/devguides/collection/ga4/views).

The client disables the tag's automatic initial page view. For GA's page URL and
title context, it supplies only the site origin plus a canonical top-level route
such as `/#/agent` or `/#/invite`, including at configuration scope for automatic
events. Browser pathnames, query strings, hash parameters, dynamic identifiers,
and UI-derived titles are discarded, so an invitation token, conversation ID,
organization ID, or project ID is never included in `page_location`. Google
signals and ad-personalization signals are disabled by the client configuration.

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
deployment variable and republishing the SPA disables collection again.

## Verify

Republish the SPA, open the deployed site, and navigate between two sidebar
routes. Verify the tag with [Google Tag
Assistant](https://tagassistant.google.com/) or GA4 DebugView/Realtime:

- exactly one `page_view` appears for the initial route;
- one additional `page_view` appears per route transition; and
- `page_location` contains only the normalized route, with no hash query string
  or internal identifier.

The integration controls what AI Fleet sends, but it does not add a consent
banner or privacy policy. The operator remains responsible for any consent,
disclosure, retention, and regional controls required for the deployment.
