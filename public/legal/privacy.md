# Privacy Notice

**Draft for qualified legal review — not legal advice or a final privacy policy.**

**Last updated:** August 15, 2026

This English-language draft describes how AI Fleet is designed to handle data.
It does not replace deployment-specific disclosures from the person or
organization operating your AI Fleet instance.

> **Legal-review notice.** This notice was prepared from the Software's
> documentation and source code, not by a lawyer. Qualified legal counsel must
> review and adapt it before it is relied on or represented as a final privacy
> notice. Nothing here claims compliance with any particular privacy law.

---

## 1. Operator and scope

Nirav Shah publishes AI Fleet (the "Software"). An organization or individual
may operate the Software locally or in its own cloud project. That deployment
operator determines why and how information is processed in its instance,
which optional services are configured, where data is hosted, and which
retention and access policies apply.

This notice covers information handled through the AI Fleet browser application
and its supporting services. It does not override the privacy notices or terms
of third-party services that an operator or user chooses to connect.

## 2. Identity and authentication data

In a deployment that requires sign-in, AI Fleet uses Firebase Authentication
with enabled identity providers such as Google or Microsoft. The Software may
receive and use an account subject identifier, display name, email address,
email-verification status, profile image, authentication provider, and
organization role or permissions. Authentication tokens are used to establish
and verify a session and authorize workspace requests.

Identity information is used to sign you in, show the correct account and
workspace, enforce organization and project access, record accountable actions,
and protect service endpoints. The configured identity provider and Firebase
process authentication data under their own terms and privacy notices.

## 3. Workspace and operational data

AI Fleet processes data that you, your organization, or connected services make
available to it. Depending on configuration and use, this can include:

- organization, member, role, project, ticket, milestone, and workflow data;
- prompts, instructions, plans, call transcripts or notes, conversation
  history, agent messages, approvals, and AI-generated output;
- repository metadata and the source code or other files needed for an agent
  task;
- model, runtime, connector, deployment, and workspace settings; and
- job status, timestamps, errors, audit information, traces, token usage,
  latency, cost, and other operational logs.

AI Fleet uses this information to provide the requested planning, coding,
testing, deployment, collaboration, troubleshooting, and reporting features.
Autonomous agents may create or update records in connected project trackers
and source-code hosts when instructed and authorized to do so.

## 4. Credentials and security

Users or operators may configure API keys, OAuth tokens, repository or project
tracker credentials, model-provider credentials, and other secrets. AI Fleet is
designed to keep credentials server-side and return only masked presence or
readiness information to the browser.

In the managed cloud design, customer credentials are encrypted in an
organization-scoped vault and an egress proxy injects them into authorized
third-party requests without placing raw provider credentials in agent
containers. A local deployment can store credentials in its local server data
store, whose security depends on the host, file permissions, backups, and
operator practices. No system can guarantee absolute security. Promptly revoke
or rotate a credential if you believe it has been exposed.

## 5. Browser storage and essential functionality

The browser uses local storage and authentication storage for essential and
preference features. These records can include theme and language choices,
sidebar state, the selected organization or project, the last workspace route,
organization-scoped workflow drafts, and authentication state maintained by
the configured sign-in provider. Essential functionality cannot be turned off
through Cookie Preferences because the application may not work correctly
without it.

The analytics choice is stored separately in local storage as
`ai-fleet.analytics-consent`, with a value of `enabled` or `disabled`. Clearing
browser data can remove these preferences and cause default behavior to apply
again.

## 6. Optional Google Analytics 4 telemetry

An operator may configure an optional Google Analytics 4 (GA4) web data stream.
If no valid GA4 measurement ID is configured, the Google tag is not downloaded
and AI Fleet sends no GA4 page views. When GA4 is configured, analytics is
enabled by default under the selected opt-out model until you disable it in
Cookie Preferences.

The integration sends a normalized top-level route, a generic page title, and
an `anonymous` or `authenticated` status for page-view measurement. For a
signed-in Firebase user, it can configure GA4 with the stable, opaque account
subject as Google's `user_id`. It is designed not to send email addresses,
display names, organization or project identifiers, invitation tokens, browser
query strings, or dynamic UI titles. Google may set `_ga` and `_ga_*` cookies
and process the resulting telemetry under the [Google Privacy
Policy](https://policies.google.com/privacy).

Disabling Analytics persists the opt-out, stops future AI Fleet page views,
issues a consent-revocation update if the Google tag is already loaded, expires
GA cookies accessible to the application, and reloads the same application
route. On later startup, AI Fleet does not create Google analytics globals or
download the Google tag while the stored choice remains disabled. An opt-out
does not remove data that Google or the deployment operator received before the
choice changed.

## 7. Third parties and data transfers

Data goes to a third party only as needed for features selected and configured
by a user or deployment operator. Those services may include:

- Firebase, Google, or Microsoft for identity and authentication;
- Google Cloud services for hosting, databases, messaging, secrets, and jobs;
- hosted LLM providers such as OpenAI, Anthropic, or Google, or a local model
  provider selected for a task;
- project trackers such as Linear, Jira, or Asana;
- source-code hosts such as GitHub or GitLab;
- LangSmith for optional tracing and operational analytics;
- Google Analytics for optional website telemetry; and
- search or other tools explicitly enabled for an agent workflow.

When a hosted model or tool is selected, relevant prompts, tickets, repository
content, or output may be sent to that provider. A local model can keep model
inference on the operator's machine for that task, although other configured
connectors may still receive data. Third parties determine their own locations,
retention, security, and legal terms.

## 8. Retention and deletion

AI Fleet does not establish one universal retention period for every
deployment. Workspace records, job history, settings, and operational data may
remain until a user or operator deletes them or applies a deployment-specific
retention policy. Credentials remain until they are replaced, removed, or the
related account is deleted; revocation at the provider may also be necessary.

Browser preferences remain until they are replaced or browser storage is
cleared. Logs, backups, cloud records, and previously shared third-party data
may remain for the periods configured by the deployment operator or third-party
provider. Deleting information from AI Fleet does not automatically delete a
copy already sent to a connected service.

## 9. Your choices and requests

Depending on your deployment and permissions, you can:

- open **Cookie Preferences** to disable or re-enable Analytics;
- choose local or hosted models and which external connectors to use;
- clear local browser storage and sign out of the configured identity provider;
- remove or rotate credentials and disconnect third-party accounts;
- review, correct, export, or delete workspace information through available
  product and provider controls; and
- ask the deployment operator about access, correction, deletion, retention,
  objections, or other privacy requests that may apply to your account.

Some requests may need to be directed to the deployment operator or the
relevant third-party provider rather than to the Software publisher.

## 10. Contact

Questions about this draft or the Software's privacy design may be sent to
[niravshah2705@gmail.com](mailto:niravshah2705@gmail.com). For account-specific
or organization-specific requests, contact the operator of your AI Fleet
deployment first.

## 11. Draft and legal-review status

This is a product draft intended for qualified legal review. It is not legal
advice, a certification, or a representation that a particular deployment
complies with privacy, cookie, consumer-protection, employment, data-transfer,
or sector-specific law. The final notice must identify the applicable operator,
purposes, lawful bases where required, regional rights, retention periods,
international-transfer safeguards, and contact details for the actual
deployment.

---

© 2026 Nirav Shah. All rights reserved.
