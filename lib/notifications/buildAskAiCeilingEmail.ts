/** Pure builder for the owner's ceiling alert (spec §9.6). Mirrors buildFeedbackEmail.ts: no network. */
export interface AskAiCeilingEmailInput { level: 80 | 100; month: string; costMicro: number; ceilingMicro: number; questions: number }
interface BuiltEmail { subject: string; text: string; html: string }
const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
const monthName = (month: string) => new Date(`${month}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildAskAiCeilingEmail(i: AskAiCeilingEmailInput): BuiltEmail {
  const subject = i.level === 100 ? 'Ask AI is paused: monthly ceiling reached' : 'Ask AI is at 80% of its monthly ceiling';
  const lines = [
    `Ask AI has used ${usd(i.costMicro)} of the ${usd(i.ceilingMicro)} ceiling for ${monthName(i.month)} (${i.questions.toLocaleString('en-US')} questions).`,
    i.level === 100
      ? 'Ask AI is now paused for everyone, admins included, until the month ends or the ceiling is raised.'
      : 'When the ceiling is reached, Ask AI pauses for everyone, admins included, until the month ends or the ceiling is raised.',
    'To raise it, set ASK_AI_GLOBAL_MONTHLY_CEILING_USD in Vercel and redeploy. The admin page (/admin/ask-ai) shows spend by member.',
  ];
  return { subject, text: lines.join('\n\n'), html: `<p>${lines.map(escape).join('</p><p>')}</p>` };
}
