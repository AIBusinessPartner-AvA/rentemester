/**
 * The SMTP2GO send call and how to read its answer (#DLK-branding).
 *
 * WHY THIS IS ITS OWN MODULE: sending an invoice is the one step that cannot be
 * undone. The decision "did SMTP2GO actually take responsibility for this mail?"
 * gates whether Rentemester's own `email_send_log` records the send — and that
 * log is what stops the same invoice going out twice. Getting the answer wrong
 * in either direction is expensive: a false "sent" burns the idempotency key on
 * a mail the customer never received; a false "not sent" invites a duplicate.
 *
 * So the interpretation is a pure function of the HTTP response, tested against
 * a fake, rather than an `if` buried in a script that can only be exercised by
 * sending a real mail to a real customer.
 *
 * THE SUBTLETY THAT MOTIVATES MOST OF THIS FILE: an immediate send and a
 * scheduled send return DIFFERENT receipts. Immediate gives `succeeded`/`failed`
 * counts. Scheduled gives a `schedule_id` and no counts — the mail is queued,
 * not delivered. Reading a scheduled response with the immediate rule reports
 * failure for a mail that is perfectly well queued, and vice versa.
 *
 * `fetch` is injected so the call can be tested without a network.
 */

/** One attachment in SMTP2GO's v3 email/send body. */
export type Smtp2goAttachment = {
  filename: string;
  /** Base64-encoded file content. SMTP2GO calls this "fileblob". */
  fileblob: string;
  mimetype: string;
};

/** The request body SMTP2GO's v3 email/send endpoint expects. */
export type Smtp2goPayload = {
  api_key: string;
  sender: string;
  to: string[];
  subject: string;
  html_body: string;
  text_body: string;
  attachments: Smtp2goAttachment[];
  /** ISO 8601 UTC. Present only for a deferred delivery. */
  schedule?: string;
};

export const SMTP2GO_SEND_ENDPOINT = "https://api.smtp2go.com/v3/email/send";

export type Smtp2goOutcome = {
  /** True only when SMTP2GO has taken responsibility for the mail. */
  ok: boolean;
  /** "OK" delivered now, "SCHEDULED" queued for later, "FAIL" neither. */
  status: "OK" | "SCHEDULED" | "FAIL";
  /** 0 when the request never reached SMTP2GO. */
  httpStatus: number;
  succeeded?: number;
  failed?: number;
  emailId?: string;
  scheduleId?: string;
  /** Set only when fetch itself threw (DNS, TLS, offline). */
  networkError?: string;
  /** Response body as received, for error display. Never contains the API key. */
  raw: string;
};

export function buildSmtp2goPayload(input: {
  apiKey: string;
  sender: string;
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  attachmentFilename: string;
  attachmentBase64: string;
  attachmentMimetype?: string;
  /** ISO 8601 UTC; omitted entirely for an immediate send. */
  schedule?: string;
}): Smtp2goPayload {
  return {
    api_key: input.apiKey,
    sender: input.sender,
    to: [input.to],
    subject: input.subject,
    html_body: input.htmlBody,
    text_body: input.textBody,
    attachments: [{
      filename: input.attachmentFilename,
      fileblob: input.attachmentBase64,
      mimetype: input.attachmentMimetype ?? "application/pdf",
    }],
    // Spread rather than `schedule: undefined`, so an immediate send sends no
    // schedule key at all.
    ...(input.schedule ? { schedule: input.schedule } : {}),
  };
}

/**
 * Decide whether SMTP2GO accepted the mail.
 *
 * A scheduled send is judged ONLY by the presence of a `schedule_id`, and an
 * immediate send ONLY by the counts. Neither rule is allowed to stand in for
 * the other: a `succeeded` count on a request we scheduled would mean SMTP2GO
 * did something other than what we asked, and that is a failure, not a success.
 */
export function interpretSmtp2goResponse(args: {
  httpStatus: number;
  httpOk: boolean;
  bodyText: string;
  /** True when the request carried a `schedule` field. */
  scheduled: boolean;
}): Smtp2goOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args.bodyText);
  } catch {
    parsed = undefined;
  }
  const data = (parsed as {
    data?: { succeeded?: number; failed?: number; email_id?: string; schedule_id?: string };
  } | undefined)?.data;

  const succeeded = typeof data?.succeeded === "number" ? data.succeeded : undefined;
  const failed = typeof data?.failed === "number" ? data.failed : undefined;
  const emailId = typeof data?.email_id === "string" ? data.email_id : undefined;
  const scheduleId = typeof data?.schedule_id === "string" ? data.schedule_id : undefined;

  const ok = args.scheduled
    ? args.httpOk && Boolean(scheduleId)
    : args.httpOk && (succeeded ?? 0) >= 1 && (failed ?? 0) === 0;

  return {
    ok,
    status: ok ? (args.scheduled ? "SCHEDULED" : "OK") : "FAIL",
    httpStatus: args.httpStatus,
    succeeded,
    failed,
    emailId,
    scheduleId,
    raw: args.bodyText,
  };
}

/**
 * One tab-separated line for `invoices/smtp2go-delivery.log`.
 *
 * The log is an audit trail, so it must never carry the API key — the payload
 * does, and the two must not be confused. Missing values are written as "-"
 * rather than omitted, so the columns line up when read with `cut`.
 */
export function formatDeliveryLogLine(args: {
  at: Date;
  outcome: Smtp2goOutcome;
  invoiceNumber: string;
  kind: string;
  to: string;
  fromEmail: string;
  schedule?: string;
}): string {
  const { outcome } = args;
  return [
    args.at.toISOString(),
    outcome.status,
    args.invoiceNumber,
    args.kind,
    args.to,
    `from=${args.fromEmail}`,
    `email_id=${outcome.emailId ?? "-"}`,
    `schedule=${args.schedule ?? "-"}`,
    `schedule_id=${outcome.scheduleId ?? "-"}`,
    `http=${outcome.httpStatus}`,
  ].join("\t") + "\n";
}

/**
 * POST the payload and interpret the answer. `fetchImpl` defaults to the global
 * `fetch`; tests pass a fake. A thrown fetch (offline, DNS, TLS) becomes a FAIL
 * outcome with `networkError` rather than an exception, so the caller has one
 * shape to handle.
 */
export async function sendViaSmtp2go(
  payload: Smtp2goPayload,
  opts: { fetchImpl?: typeof fetch; endpoint?: string } = {},
): Promise<Smtp2goOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? SMTP2GO_SEND_ENDPOINT;
  const scheduled = Boolean(payload.schedule);

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return {
      ok: false,
      status: "FAIL",
      httpStatus: 0,
      networkError: (error as Error).message,
      raw: "",
    };
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    // A response whose body cannot be read tells us nothing about delivery, so
    // it is a failure — never assume the mail went out.
    return {
      ok: false,
      status: "FAIL",
      httpStatus: response.status,
      networkError: `kunne ikke læse svaret: ${(error as Error).message}`,
      raw: "",
    };
  }

  return interpretSmtp2goResponse({
    httpStatus: response.status,
    httpOk: response.ok,
    bodyText,
    scheduled,
  });
}
