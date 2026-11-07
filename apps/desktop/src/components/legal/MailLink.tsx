/**
 * An e-mail address in a legal document, as a mailto link (addresses come from
 * operator.ts). target="_blank" like the app's other external links: the
 * desktop shell hands such a click to the system mail client, where a plain
 * mailto link may do nothing in some webviews.
 */
export function MailLink({ address }: { address: string }) {
  return (
    <a
      href={`mailto:${address}`}
      target="_blank"
      rel="noopener noreferrer"
      className="text-vox-accent-primary hover:underline"
    >
      {address}
    </a>
  );
}
