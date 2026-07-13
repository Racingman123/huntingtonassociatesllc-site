# Communications, privacy, and launch controls

This is an engineering control checklist, not legal advice. A real staffing company must have counsel review the exact calling/texting use case, jurisdictions, worker agreements, union rules, retention policy, and any state-specific automated-call or recording law before launch.

## Controls implemented in the product

- Voice and SMS consent are separate, explicit profile fields with date and source evidence.
- Do-not-call and do-not-text flags are rechecked immediately before each communication.
- Calls disclose that the worker is speaking to an automated scheduling assistant.
- The default contact window is 8:00 a.m.–8:00 p.m. in the worker's timezone and is configurable.
- SMS identifies the staffing company and contains a STOP instruction.
- Twilio STOP/START/HELP metadata is synchronized back to the worker record.
- No audio recording is enabled. Minimal turn text is stored only for operational review.
- Provider webhooks are signature-validated in production.
- Each acceptance, decline, suppression, communication, and operator change is auditable.
- Model actions are limited to server-validated scheduling tools.
- Secrets are environment variables and are never returned to the browser.

Twilio's policy requires consent before A2P messages, retained proof of consent, clear sender identification, and a one-step opt-out. Informational reminders still require consent. See the current [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy) and [Advanced Opt-Out documentation](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).

## Required company decisions before live traffic

1. Name the legal sender displayed in calls and texts.
2. Document how voice and SMS consent are collected, with the exact language, date, source, and scope.
3. Register the Twilio sender/messaging campaign required for the destination countries and traffic type.
4. Decide the approved calling hours for every worker jurisdiction.
5. Decide whether voicemail may contain shift details. The safe default is a generic callback request.
6. Define a human escalation number and staffing coverage hours.
7. Approve transcript and audit retention periods; the sample default is 90 days for transcripts.
8. Establish an access-review, incident-response, worker data-correction, and deletion process.
9. Run a privacy/security review and execute vendor agreements or data-processing terms where required.
10. Test consent revocation and re-opt-in end to end with the exact Twilio Messaging Service configuration.

## Production launch gate

Do not enable `COMMUNICATION_PROVIDER=twilio` until all items below are true:

- production HTTPS domain is live;
- PostgreSQL backups and restore drill are verified;
- strong unique `JWT_SECRET` and administrator password are configured;
- a non-owner scheduler role has been tested;
- Twilio webhook signature validation is enabled;
- Twilio phone number and Messaging Service are approved for the intended traffic;
- OpenAI and Twilio spend/rate alerts are configured;
- worker consent evidence has been imported and sampled;
- test numbers complete calls, speech turns, accept/decline, STOP, reminders, and provider retries;
- an operator can pause automation and contact workers manually;
- counsel has approved disclosure, consent, calling hours, and message templates.

## Data handling guidance

Store only staffing data needed for scheduling. Do not put Social Security numbers, banking data, medical information, immigration documents, or background-check contents in free-text notes, model prompts, call transcripts, or SMS. Keep those in a separately controlled HR system and pass only eligibility booleans or certification names needed to match a shift.

Restrict database and log access by job function. Logs should contain opaque record IDs, not phone numbers, access tokens, full message bodies, or prompt payloads. Rotate provider credentials immediately after suspected exposure.
