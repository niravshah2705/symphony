# Privacy Notice

- **Publisher:** Archagentix Private Limited (CIN U62011PN2026PTC260563, GSTIN
  27ABGCA7851D1ZN), registered office at Hinjewadi IT Park, Pune 411057,
  Maharashtra, India
- **Product:** Software Factory, hosted at `https://platform.archagentix.com/`
  (marketed before November 2026 as "AI Fleet")
- **Effective date:** November 20, 2026
- **Version:** 1.1.0

This notice is written to be read on its own, in plain language, and to be
understandable without reference to any other document we publish. It describes
what personal data we handle, for which specific purpose, who else receives it,
how long we keep it, and how you tell us to stop. It is incorporated into and
forms part of the [Terms of Service](#/terms).

We prepared this notice by reference to the Digital Personal Data Protection
Act, 2023 and the Digital Personal Data Protection Rules, 2025, which are being
commenced in phases through 2027. The commitments below are the ones we apply
now, in every deployment, and not only once those provisions are in force.

## 1. Who we are, and your two possible relationships with us

Archagentix Private Limited is a company incorporated in Pune, Maharashtra,
India. We host and operate Software Factory for customers who subscribe at
`https://platform.archagentix.com/`, and we also distribute it so that an
organization can run it inside its own cloud project or on its own machine.

The two cases differ in who decides why data is processed:

- **The hosted service.** We are the **Data Fiduciary** for your account,
  billing, security and service-usage data, because we decide why that data is
  processed. For the workspace content you put into the service — prompts,
  plans, tickets, source code and generated output — we process it **on your
  instructions** as your **Data Processor**, and only to deliver the features
  you have configured.
- **Your own deployment.** The organization or individual running it decides
  why and how information is processed, which optional services are
  configured, where data is hosted, and which retention and access policies
  apply. That operator is the Data Fiduciary, and this notice describes the
  software's design rather than replacing that operator's own disclosures to
  its users.

Contact details for both cases are in section 16.

## 2. The personal data we handle, and the purpose of each

This is the itemised list. We do not process personal data for a purpose that
is not described here.

| Personal data | Specified purpose |
| --- | --- |
| Name, work email address, email-verification status, profile image, the identity provider you used, and a stable account identifier | Signing you in, showing the correct account and workspace, and securing the session |
| Organization, member, role and project-assignment records | Enforcing organization and project access, and recording who authorized an action |
| Billing contact, plan, seat count, invoices, and the last four digits, brand and expiry of the payment method we hold on file | Taking payment, issuing GST invoices, and servicing refunds and disputes |
| Prompts, instructions, plans, conversation history, agent messages, approvals, and generated output | Running the planning and code-writing work you ask for, and showing you its results |
| Repository metadata, and the source files a task needs | Letting an agent read, change and propose code in the repository you connected |
| Ticket, milestone and workflow data from a connected tracker | Reading the work item you pointed an agent at, and writing its result back |
| Job status, timestamps, errors, audit records, traces, token usage, latency and cost | Operating the service, showing you run history and spend, and diagnosing failures |
| Theme, language, sidebar, selected organization/project, last route, and unsent workflow drafts | Restoring the workspace to the state you left it in |
| Support correspondence you send us | Answering it |

We do not collect payment card numbers in full, government identity numbers,
precise geolocation, or any data about health, financial status, biometrics,
religion or sexual orientation. We do not sell personal data, and we do not use
it for advertising about third-party products.

## 3. Consent, and how you take it back

Where we rely on your consent, we ask for it before the processing starts, with
the purposes in section 2 presented itemised rather than as one bundled
acceptance. You give consent when you create an account and when you connect
each third-party service, and each of those is a separate choice.

**Withdrawal is as easy as giving it.** Analytics is one click in **Cookie
Preferences**. Disconnecting a tracker, source-code host or model provider is
one click in **Settings** next to that integration. Closing the whole account is
in **Settings → Billing** and **Settings → Organization**. Withdrawing consent
stops the processing that rested on it from that moment; it does not undo
processing that already happened, and it does not affect processing we carry out
as your Data Processor on your instructions.

Some processing we treat as a **legitimate use** rather than a consent matter,
because it protects you, us, or the contract we have with you: authentication,
access control, fraud and abuse prevention, security logging, billing, tax
record-keeping, and responding to your requests. Where we rely on this, we limit
it to those activities.

## 4. Identity and authentication data

In a deployment that requires sign-in, Software Factory uses Firebase
Authentication with enabled identity providers such as Google or Microsoft. The
software may receive and use an account subject identifier, display name, email
address, email-verification status, profile image, authentication provider, and
organization role or permissions. Authentication tokens are used to establish and
verify a session and authorize workspace requests.

We store an opaque account identifier, not your password. The configured identity
provider and Firebase process authentication data under their own terms and
privacy notices, and the choice of provider is theirs, not ours.

## 5. Workspace and operational data

Software Factory processes data that you, your organization, or connected
services make available to it. Depending on configuration and use, this can
include:

- organization, member, role, project, ticket, milestone, and workflow data;
- prompts, instructions, plans, call transcripts or notes, conversation
  history, agent messages, approvals, and AI-generated output;
- repository metadata and the source code or other files needed for an agent
  task;
- model, runtime, connector, deployment, and workspace settings; and
- job status, timestamps, errors, audit information, traces, token usage,
  latency, cost, and other operational logs.

We use this information to provide the requested planning, coding, testing,
deployment, collaboration, troubleshooting, and reporting features. Autonomous
agents may create or update records in connected project trackers and
source-code hosts when instructed and authorized to do so.

**Model providers and your content.** When you route a task to a hosted model
provider, the prompt and the repository or ticket content for that task go to
that provider so it can generate the answer. That transfer is the service you
asked for. Providers process under their own terms and generally retain little
or nothing for API traffic, but they are outside our control; you choose the
provider per role, and a local model keeps inference on your own machine.

## 6. Credentials and security safeguards

Users and operators configure API keys, OAuth tokens, repository and tracker
credentials, and model-provider credentials. The design keeps those secrets
server-side, encrypts them at rest in an organization-scoped vault, and returns
only masked presence information to the browser. An egress proxy injects a
credential into an authorized outbound request outside the agent's own sandbox,
so an agent container never holds a raw provider key.

The safeguards we maintain over personal data are:

- **Encryption** of personal data in transit (TLS) and of stored credentials and
  organization secrets at rest, with masking of card numbers and secret values
  wherever they are displayed;
- **Access control** to the computer resources that hold personal data, limited
  to the identities a role needs, with the shared-secret and workload-identity
  boundaries described in the Terms;
- **Logging, monitoring and periodic review** sufficient to detect, investigate
  and remediate a breach;
- **Continuity measures**, including scheduled backups of the operational data
  store, so that a lost or corrupted record can be restored;
- **Retention of security logs and of the data needed to investigate an
  incident for one year**, after which they are erased unless a specific legal
  obligation requires longer; and
- **Written security obligations on every Data Processor** we engage, listed in
  section 9.

No system can guarantee absolute security. Promptly revoke or rotate a
credential if you believe it has been exposed, and tell us at the address in
section 16 so we can act on it.

## 7. Browser storage, cookies and essential functionality

The browser uses local storage and authentication storage for essential and
preference features. These records can include theme and language choices,
sidebar state, the selected organization or project, the last workspace route,
organization-scoped workflow drafts, and authentication state maintained by the
configured sign-in provider. Essential functionality cannot be turned off
through Cookie Preferences because the application may not work correctly
without it.

The analytics choice is stored separately in local storage as
`ai-fleet.analytics-consent`, with a value of `enabled` or `disabled`. That key
keeps the product's earlier name deliberately: your recorded choice must survive
a rebrand, so we do not rename the place where it is stored. Clearing browser
data removes these preferences and causes default behavior to apply again.

## 8. Optional Google Analytics 4 telemetry

An operator may configure an optional Google Analytics 4 (GA4) web data stream.
If no valid GA4 measurement ID is configured, the Google tag is not downloaded
and no GA4 page view is sent. When GA4 is configured, page-view measurement is
on by default and you switch it off in **Cookie Preferences**; the moment you do,
the tag stops loading and a consent-revocation update is sent to GA4 if the tag
was already loaded.

The integration sends a normalized top-level route, a generic page title, and an
`anonymous` or `authenticated` status for page-view measurement. For a signed-in
Firebase user, it can configure GA4 with the stable, opaque account subject as
Google's `user_id`. It does not send email addresses, display names,
organization or project identifiers, invitation tokens, browser query strings,
or dynamic UI titles. Google may set `_ga` and `_ga_*` cookies and process the
resulting telemetry under the [Google Privacy
Policy](https://policies.google.com/privacy).

Disabling Analytics persists the opt-out, stops future page views, expires GA
cookies accessible to the application, and reloads the same application route.
On later startup, the application does not create Google analytics globals or
download the Google tag while the stored choice remains disabled. An opt-out
does not remove data that Google or the deployment operator received before the
choice changed.

## 9. Who else handles data

Data goes to a third party only as needed for features selected and configured
by a user or deployment operator. Each of the following is a Data Processor or,
where you connect it yourself, a service you choose directly:

- Firebase, Google, or Microsoft for identity and authentication;
- Google Cloud services for hosting, databases, messaging, secrets, and jobs;
- hosted LLM providers such as OpenAI, Anthropic, or Google, or a local model
  provider selected for a task;
- project trackers such as Linear, Jira, or Asana;
- source-code hosts such as GitHub or GitLab;
- Stripe and Flexprice for card payment, subscription and invoice management;
- Langfuse for optional tracing and operational analytics;
- Google Analytics for optional website telemetry; and
- search or other tools explicitly enabled for an agent workflow.

We hold a written agreement with each processor we engage for our own service
that obliges it to secure the personal data it handles, to process it only on
our instructions, and to assist with breach notification and data-principal
requests. Third-party services you connect directly are governed by their own
terms, locations, retention and security practices.

## 10. Transfers of personal data outside India

The hosted service runs on Google Cloud, and the platform's compute and storage
are currently provisioned in Google Cloud regions outside India (including
`us-central1`), with model providers and other processors typically located
outside India as well. Personal data therefore crosses borders as an ordinary
part of the service.

The Digital Personal Data Protection Act, 2023 permits transfer of personal data
for processing to any country unless the Central Government restricts that
country by notification, and the Rules, 2025 confirm transfer outside India is
permitted subject to any requirement the Central Government specifies. If a
restriction is notified that affects our arrangements, we will tell affected
customers and adjust the deployment rather than continue the transfer. If your
own obligations require data to stay in India, an Enterprise deployment can be
provisioned inside your own Indian cloud project, where you choose the regions.

## 11. How long we keep it, and deletion

We keep personal data only while the purpose in section 2 that justifies it is
still being served, and we erase it when that purpose ends or when you withdraw
consent and no other ground applies. Specifically:

- **During your subscription:** account, workspace, billing and audit records are
  kept so the service can do its job.
- **After cancellation:** you can export your workspace for **30 days**, as the
  [Refund and Cancellation Policy](#/refund) states. We then delete account,
  workspace and operational records within **30 days** of that window closing.
- **Invoices and payment records:** kept for the period Indian tax and company
  law requires (eight years for books of account), and not for any other purpose.
- **Security logs and incident records:** one year, as section 6 states.
- **Browser preferences:** until you replace them or clear browser storage.
- **Content you delete:** deleted from the active workspace promptly. Backups are
  overwritten as they roll off on their normal schedule, so a small number of
  records may persist briefly in backup and are not restored except to recover
  from a failure.

Deletion of what we hold does not delete a copy already delivered to a connected
tracker, source-code host or model provider under your own configuration; those
are governed by that service.

## 12. Your rights, and how to exercise each

Under the Act you may ask us to:

- **access** information about the personal data we process about you, and the
  identities of the processors it went to (section 11 of the Act);
- **correct or complete** inaccurate or misleading personal data, and
  **erase** data that is no longer needed for the purpose in section 2
  (section 12 of the Act);
- **withdraw consent** at any time (section 6(4) of the Act), as section 3 above
  describes;
- **nominate** another person to exercise your rights in the event of death or
  incapacity (section 14 of the Act); and
- **grieve** to us first, and then to the Data Protection Board of India if we
  do not resolve it (section 13 of the Act).

**How to make a request.** Email **support@archagentix.com** with the subject
line "Data request", or write to the postal address in section 16. For an
in-workspace request you do not need to contact anyone at all: export,
correction and deletion are available in **Settings** under your own account,
and analytics and connector choices in **Cookie Preferences** and **Settings**.

**What we need from you.** We must verify you are the account holder before
disclosing or changing anything, so include the email address on the account, or
your account's subject identifier or username as shown in **Settings**, and the
organization name if the request concerns workspace data. We will tell you if we
need more to identify you. A request can be made to us only in respect of data
you consented to with us; for your own deployment, address it to that operator.

**Our timeline.** We acknowledge a request within **3 business days** and
substantively respond within **30 days**. The Rules, 2025 permit a grievance
response window of up to ninety days; we hold ourselves to thirty. If a request
is complex we will tell you the reason for delay and the expected date within
that 30-day period. Requests to our service are free of charge.

**Complaining to the Board.** If you are not satisfied with our response, you may
complain to the Data Protection Board of India, established under the Act,
through its published portal at the address the Board specifies. We will include
that route in every response we send you about a rights request.

## 13. Children

Software Factory is a business tool for registered organizations and adult
users. "Child" means an individual who has not completed eighteen years of age,
and we do not intend to process the personal data of children. Our sign-in
requires a business or work account and the Terms may only be accepted by an
adult, which is the due diligence we perform to confirm a Data Principal is not
a child.

We do not track or behaviourally monitor children, and we do not direct targeted
advertising at them. If we learn that a child's personal data has been processed,
we erase it, except where a limited purpose or exemption permits us to keep it.
If you believe a child has given us personal data, tell us at section 16 and we
will act on it.

## 14. If our security fails: breach notification

Becoming aware of a personal data breach triggers two obligations, and we commit
to both:

1. **To you, without delay**, through the email or in-app channel you registered
   with us, in concise plain language: what happened, including its nature,
   extent and timing; the consequences likely for you; what we have done and are
   doing to contain and mitigate it; what you can do to protect yourself; and the
   business contact details of the person who can answer your questions about it.
2. **To the Data Protection Board of India**: an initial intimation without
   delay, and a detailed report — including the facts and causes, mitigation,
   findings about who caused the breach, remedial measures to prevent recurrence,
   and a record of the intimations sent to affected individuals — within
   **seventy-two hours** of becoming aware, or any longer period the Board allows
   on our written request.

Where a deployment is run by an operator rather than by us, the operator is the
Data Fiduciary and owns these notifications; we tell the operator without delay
and help with the information the notification needs.

## 15. Changes to this notice

We may update this notice as the product, our processors or the law change. The
version and effective date at the top of this page record the current text. When
a change materially affects the purposes in section 2, adds a new processor, or
narrows a right, we notify the account email at least **15 days** before it
applies and record the earlier version. Continued use after the change date means
the new notice applies to processing from then on.

## 16. Questions and grievances

The person who answers questions about the processing of your personal data, and
who handles grievances under section 13 of the Act, is the **Grievance Officer,
Archagentix Private Limited**. You can reach that role at:

- **Email:** [support@archagentix.com](mailto:support@archagentix.com)
- **Phone:** [+91 93705 80836](tel:+919370580836), Monday to Friday,
  10:00–19:00 India Standard Time
- **Post:** Grievance Officer, Archagentix Private Limited, Hinjewadi IT Park,
  Pune 411057, Maharashtra, India

These details appear in every response we send to a request under section 12. For
account-specific or organization-specific requests about a deployment you operate,
contact the operator of that deployment first, since we act there only as its
processor.

---

© 2026 Archagentix Private Limited. All rights reserved.
