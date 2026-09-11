const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

/** An address as Mailpit's API reports it. */
export interface MailpitAddress {
  Name: string;
  Address: string;
}

/** An entry from `GET /api/v1/messages` — headers only, no body. */
export interface MailpitMessageSummary {
  ID: string;
  From: MailpitAddress;
  To: MailpitAddress[];
  Subject: string;
}

/** A single message from `GET /api/v1/message/{id}` — includes the rendered body. */
export interface MailpitMessage extends MailpitMessageSummary {
  HTML: string;
  Text: string;
}

export async function getMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as { messages?: MailpitMessageSummary[] };
  return data.messages ?? [];
}

export async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessage;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
